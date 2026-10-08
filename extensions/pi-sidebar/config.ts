/**
 * Sidebar extension config, stored under `custom.sidebar` in the pi settings
 * file (`~/.pi/agent/settings.json`, honoring `PI_CODING_AGENT_DIR`). Values are
 * clamped to the same bounds the `/sidebar width` and `/sidebar label-width`
 * commands enforce.
 */

import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	DEFAULT_LABEL_WIDTH,
	DEFAULT_WIDTH,
	MAX_LABEL_WIDTH,
	MAX_WIDTH,
	MIN_LABEL_WIDTH,
	MIN_WIDTH,
	SHARED_DIR,
} from "./types.ts";

export interface Config {
	width: number;
	labelWidth: number;
}

const agentDir = dirname(SHARED_DIR);
export const settingsPath = join(agentDir, "settings.json");
// Deliberately NOT `settings.json.lock`: pi core locks that exact path as a
// directory via proper-lockfile, so a regular file there would break its writes.
const lockPath = `${settingsPath}.pi-config.lock`;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
/** A lock older than this was left by a hard kill: the critical section is a fast read+write. */
const LOCK_STALE_MS = 10_000;

/** Coerce a value to a usable column count. */
export const clampWidth = (value: number): number => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(value)));

/** Coerce a value to a usable process-label width. */
export const clampLabelWidth = (value: number): number => Math.max(MIN_LABEL_WIDTH, Math.min(MAX_LABEL_WIDTH, Math.round(value)));

/** Parse the settings file; undefined when it exists but is unreadable or malformed. */
function parseSettings(): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : undefined;
	}
}

function normalize(raw: Partial<Config>): Config {
	const width = typeof raw.width === "number" && Number.isFinite(raw.width) ? clampWidth(raw.width) : DEFAULT_WIDTH;
	const labelWidth =
		typeof raw.labelWidth === "number" && Number.isFinite(raw.labelWidth) ? clampLabelWidth(raw.labelWidth) : DEFAULT_LABEL_WIDTH;
	return { width, labelWidth };
}

export function readConfig(): Config {
	const settings = (parseSettings() ?? {}) as { custom?: { sidebar?: Partial<Config> } };
	return normalize(settings.custom?.sidebar ?? {});
}

/** Sleep synchronously so the lock retry loop can back off without making writeConfig async. */
const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Read-modify-write the settings file under an exclusive lock so concurrent
 * writers cannot clobber each other, writing to a unique temp file and renaming
 * it into place. The lock is released even when the write fails.
 */
function updateSettings(mutate: (settings: Record<string, unknown>) => Record<string, unknown>): void {
	let lock: number | undefined;
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				lock = openSync(lockPath, "wx");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt >= LOCK_RETRIES) throw error;
				try {
					if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
				} catch {
					/* lock vanished or is unreadable */
				}
				sleepSync(LOCK_RETRY_MS);
			}
		}
		const settings = parseSettings();
		if (!settings) throw new Error("settings.json is not valid JSON");
		const tmp = `${settingsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, `${JSON.stringify(mutate(settings), null, 2)}\n`);
			renameSync(tmp, settingsPath);
		} catch (error) {
			try {
				unlinkSync(tmp);
			} catch {
				/* never created or already renamed */
			}
			throw error;
		}
	} finally {
		if (lock !== undefined) {
			try {
				closeSync(lock);
			} catch {
				/* already closed */
			}
			try {
				unlinkSync(lockPath);
			} catch {
				/* not held */
			}
		}
	}
}

/** Persist `custom.sidebar`, preserving every other settings key. Returns false when the write fails. */
export function writeConfig(config: Config): boolean {
	try {
		updateSettings((settings) => ({ ...settings, custom: { ...(settings.custom as Record<string, unknown> | undefined), sidebar: config } }));
		return true;
	} catch {
		return false;
	}
}
