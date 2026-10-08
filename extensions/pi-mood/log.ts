/**
 * pi-mood sample log. Every classification is appended as one JSON line so the
 * (state, distribution) pairs can be collected and used as a dataset later.
 *
 * Path: `PI_MOOD_LOG`, or `<agent dir>/pi-mood/log.jsonl`. Set `PI_MOOD_LOG=off`
 * to disable. Logging is best-effort and never throws.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const configured = process.env.PI_MOOD_LOG?.trim();
const disabled = configured === "off" || configured === "none";

const logPath = configured && !disabled ? configured : join(agentDir, "pi-mood", "log.jsonl");

export function appendMoodLog(record: Record<string, unknown>): void {
	if (disabled) return;
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(record)}\n`);
	} catch {
		/* logging is best-effort */
	}
}
