/**
 * Building the pane's run script: resolve the pi executable, serialize the pi
 * invocation into a shell-quoted bash script that tees the JSONL stream,
 * writes an exit sentinel, and self-cleans the pane after 10 minutes.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** How long a finished pane stays open for inspection. */
const PANE_TTL_MS = 10 * 60 * 1000;

/**
 * jq program rendering the pane's human-readable stream: text deltas as-is,
 * tool calls as `→ name {arguments}` lines. Applied to raw.jsonl via tee.
 */
const JQ_FILTER = `
if .type == "message_update" and .assistantMessageEvent.type == "text_delta" then .assistantMessageEvent.delta
elif .type == "message_end" and .message.role == "assistant" then
  "\\n" + ([.message.content[]? | select(.type=="toolCall") | "\\u2192 \\(.name) \\(.arguments|tostring)"] | join("\\n")) + "\\n"
else empty end`.trim();

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Agent names come from frontmatter and must not move outside runs/. */
export function safeRunName(name: string): string {
	return name.replace(/^\.+/, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "agent";
}

/** Resolve how to invoke pi from inside the child shell. */
export function piInvocation(): { command: string; prefixArgs: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", prefixArgs: [] };
	return { command: process.execPath, prefixArgs: [] };
}

/** Env var the child (and the title extension inside it) reads to tag its session. */
const AGENT_ENV_VAR = "PI_AGENTS_AGENT";

export function buildRunScript(runDir: string, cwd: string, command: string, args: string[], agentName: string): string {
	const cmdLine = [command, ...args].map(shellQuote).join(" ");
	const exitPath = shellQuote(path.join(runDir, "exit"));
	const script = [
		"#!/usr/bin/env bash",
		"set -o pipefail",
		// Lets the child's title extension keep the `[agent:<name>]` prefix.
		`export ${AGENT_ENV_VAR}=${shellQuote(agentName)}`,
		// Write the sentinel on a bad cwd too, or the parent polls the full timeout
		// for an exit file that will never be written.
		`cd ${shellQuote(cwd)} || { echo 1 > ${exitPath}; exit 1; }`,
		"if command -v jq >/dev/null 2>&1; then",
		`  ${cmdLine} 2>${shellQuote(path.join(runDir, "stderr.log"))} | tee ${shellQuote(
			path.join(runDir, "raw.jsonl"),
		)} | jq -j --unbuffered ${shellQuote(JQ_FILTER)}`,
		"else",
		`  ${cmdLine} 2>${shellQuote(path.join(runDir, "stderr.log"))} | tee ${shellQuote(
			path.join(runDir, "raw.jsonl"),
		)}`,
		"fi",
		`echo "\${PIPESTATUS[0]}" > ${exitPath}`,
		`sleep ${Math.floor(PANE_TTL_MS / 1000)}`,
		`tmux kill-pane -t "\${TMUX_PANE}" 2>/dev/null || true`,
		"",
	].join("\n");

	const scriptPath = path.join(runDir, "run.sh");
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	return scriptPath;
}
