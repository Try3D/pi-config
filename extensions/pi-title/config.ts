/**
 * Title extension config, stored under `custom.title` in the pi settings file
 * (`~/.pi/agent/settings.json`, honoring `PI_CODING_AGENT_DIR`). Failures are
 * appended to `title.log`.
 */

import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Persist `custom.title`, preserving every other settings key. */
export function writeConfig(config: Config): boolean {
	try {
		const settings = parseSettings();
		if (!settings) throw new Error("settings.json is not valid JSON");
		const custom = { ...(settings.custom as Record<string, unknown> | undefined), title: config };
		writeFileSync(`${settingsPath}.tmp`, `${JSON.stringify({ ...settings, custom }, null, 2)}\n`);
		renameSync(`${settingsPath}.tmp`, settingsPath);
		return true;
	} catch (error) {
		logTitleError(`write: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
