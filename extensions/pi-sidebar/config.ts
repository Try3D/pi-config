/**
 * Sidebar extension config, stored under `custom.sidebar` in the pi settings
 * file (`~/.pi/agent/settings.json`, honoring `PI_CODING_AGENT_DIR`). Values are
 * clamped to the same bounds the `/sidebar width` and `/sidebar label-width`
 * commands enforce.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Persist `custom.sidebar`, preserving every other settings key. Returns false when the write fails. */
export function writeConfig(config: Config): boolean {
	try {
		const settings = parseSettings();
		if (!settings) return false;
		const custom = { ...(settings.custom as Record<string, unknown> | undefined), sidebar: config };
		writeFileSync(`${settingsPath}.tmp`, `${JSON.stringify({ ...settings, custom }, null, 2)}\n`);
		renameSync(`${settingsPath}.tmp`, settingsPath);
		return true;
	} catch {
		return false;
	}
}
