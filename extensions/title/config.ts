/**
 * Title extension config: `~/.pi/agent/title.json` (respects
 * `PI_CODING_AGENT_DIR`), `{ enabled, model, maxTokens, maxLength }`; failures
 * are appended to `title.log`.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
	enabled: boolean;
	model: string | null;
	maxTokens: number;
	maxLength: number;
}

const DEFAULT_CONFIG: Config = { enabled: true, model: null, maxTokens: 30, maxLength: 60 };

export const configPath = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "title.json");
export const logPath = join(dirname(configPath), "title.log");

export function logTitleError(detail: string): void {
	try {
		appendFileSync(logPath, `${new Date().toISOString()} ${detail}\n`);
	} catch {
		/* logging is best-effort */
	}
}

const MAX_TOKENS_CAP = 4096;

export function readConfig(): Config {
	try {
		const raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<Config>;
		const maxTokens = typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0 ? Math.min(raw.maxTokens, MAX_TOKENS_CAP) : DEFAULT_CONFIG.maxTokens;
		const maxLength = typeof raw.maxLength === "number" && Number.isInteger(raw.maxLength) && raw.maxLength > 0 ? raw.maxLength : DEFAULT_CONFIG.maxLength;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
			maxTokens,
			maxLength,
		};
	} catch (error) {
		// A malformed config silently reverting to defaults (auto-titling on) is
		// surprising, so record it.
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			logTitleError(`config: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { ...DEFAULT_CONFIG };
	}
}

/** Persist config; returns false (and logs) when the write fails. */
export function writeConfig(config: Config): boolean {
	try {
		writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
		return true;
	} catch (error) {
		logTitleError(`write: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}
