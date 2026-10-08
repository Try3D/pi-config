/**
 * Title extension config, stored under `custom.title` in the pi settings file
 * (`~/.pi/agent/settings.json`, honoring `PI_CODING_AGENT_DIR`). Failures are
 * appended to `title.log`.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
	enabled: boolean;
	model: string | null;
	maxTokens: number;
	maxLength: number;
}

const DEFAULT_CONFIG: Config = { enabled: true, model: null, maxTokens: 30, maxLength: 60 };

export const settingsPath = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "settings.json");
export const logPath = join(dirname(settingsPath), "title.log");
// Deliberately NOT `settings.json.lock`: pi core locks that exact path as a
// directory via proper-lockfile, so a regular file there would break its writes.
const lockPath = `${settingsPath}.pi-config.lock`;
const LOCK_RETRIES = 50;
const LOCK_RETRY_MS = 20;
/** A lock older than this was left by a hard kill: the critical section is a fast read+write. */
const LOCK_STALE_MS = 10_000;

export function logTitleError(detail: string): void {
	try {
		appendFileSync(logPath, `${new Date().toISOString()} ${detail}\n`);
	} catch {
		/* logging is best-effort */
	}
}

const MAX_TOKENS_CAP = 4096;

/** Parse the settings file; undefined when it exists but is unreadable or malformed. */
function parseSettings(): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : undefined;
	}
}

function normalize(raw: Partial<Config>): Config {
	const maxTokens = typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 ? Math.min(raw.maxTokens, MAX_TOKENS_CAP) : DEFAULT_CONFIG.maxTokens;
	const maxLength = typeof raw.maxLength === "number" && Number.isInteger(raw.maxLength) && raw.maxLength > 0 ? raw.maxLength : DEFAULT_CONFIG.maxLength;
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
		maxTokens,
		maxLength,
	};
}

export function readConfig(): Config {
	const settings = (parseSettings() ?? {}) as { custom?: { title?: Partial<Config> } };
	return normalize(settings.custom?.title ?? {});
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

/** Persist `custom.title`, preserving every other settings key. */
export function writeConfig(config: Config): boolean {
	try {
		updateSettings((settings) => ({ ...settings, custom: { ...(settings.custom as Record<string, unknown> | undefined), title: config } }));
		return true;
	} catch (error) {
		logTitleError(`write: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
