/**
 * Subagent runner: build a run directory, launch `pi --mode json -p` in a tmux
 * pane, wait for exit, and collect the final text + file changes.
 *
 * The pane shows a human-readable stream (via jq); raw.jsonl keeps the
 * structured event stream for the parent.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { gitSummary } from "./changes.ts";
import { acquirePane, currentSession, killPane } from "./tmux.ts";

const PANE_TTL_MS = 10 * 60 * 1000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 400;

const JQ_FILTER = `
if .type == "message_update" and .assistantMessageEvent.type == "text_delta" then .assistantMessageEvent.delta
elif .type == "message_end" and .message.role == "assistant" then
  "\\n" + ([.message.content[]? | select(.type=="toolCall") | "\\u2192 \\(.name) \\(.arguments|tostring)"] | join("\\n")) + "\\n"
else empty end`.trim();

export interface RunResult {
	text: string;
	changes: string;
	exitCode: number | null;
	paneId: string | null;
	runDir: string;
	timedOut: boolean;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve how to invoke pi from inside the child shell. */
function piInvocation(): { command: string; prefixArgs: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", prefixArgs: [] };
	return { command: process.execPath, prefixArgs: [] };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFinalText(rawPath: string): string {
	let text = "";
	let content: string;
	try {
		content = fs.readFileSync(rawPath, "utf-8");
	} catch {
		return "";
	}
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const parts = (event.message.content ?? [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("");
			if (parts) text = parts;
		}
	}
	return text;
}

async function buildRunScript(
	runDir: string,
	cwd: string,
	command: string,
	args: string[],
): Promise<string> {
	const cmdLine = [command, ...args].map(shellQuote).join(" ");
	const script = [
		"#!/usr/bin/env bash",
		"set -o pipefail",
		`cd ${shellQuote(cwd)} || exit 1`,
		"if command -v jq >/dev/null 2>&1; then",
		`  ${cmdLine} 2>${shellQuote(path.join(runDir, "stderr.log"))} | tee ${shellQuote(
			path.join(runDir, "raw.jsonl"),
		)} | jq -j --unbuffered ${shellQuote(JQ_FILTER)}`,
		"else",
		`  ${cmdLine} 2>${shellQuote(path.join(runDir, "stderr.log"))} | tee ${shellQuote(
			path.join(runDir, "raw.jsonl"),
		)}`,
		"fi",
		`echo "\${PIPESTATUS[0]}" > ${shellQuote(path.join(runDir, "exit"))}`,
		`sleep ${Math.floor(PANE_TTL_MS / 1000)}`,
		`tmux kill-pane -t "\${TMUX_PANE}" 2>/dev/null || true`,
		"",
	].join("\n");

	const scriptPath = path.join(runDir, "run.sh");
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
	return scriptPath;
}

export async function runSubagent(options: {
	ctx: ExtensionContext;
	agent: AgentConfig;
	task: string;
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<RunResult> {
	const { ctx, agent, task, signal, onUpdate } = options;
	const cwd = options.cwd ?? ctx.cwd;

	const runId = `${agent.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const runDir = path.join(getAgentDir(), "pi-agents", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });

	// System prompt
	const promptPath = path.join(runDir, "prompt.md");
	const prompt = agent.systemPrompt.trim();
	if (prompt) fs.writeFileSync(promptPath, prompt, "utf-8");

	// Build pi args
	const { command, prefixArgs } = piInvocation();
	const args: string[] = [...prefixArgs, "--mode", "json", "-p", "--session-id", runId];
	if (agent.model) {
		args.push("--model", agent.model);
	} else if (ctx.model) {
		args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
	}
	if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	if (prompt) args.push("--append-system-prompt", promptPath);
	args.push(`Task: ${task}`);

	const scriptPath = await buildRunScript(runDir, cwd, command, args);

	if (!process.env.TMUX) {
		throw new Error("pi-agents requires tmux ($TMUX is not set). Run pi inside a tmux session.");
	}
	const session = await currentSession();
	const paneId = await acquirePane({ session, cwd, scriptPath, title: `pi:${agent.name}` });

	const exitFile = path.join(runDir, "exit");
	const rawFile = path.join(runDir, "raw.jsonl");
	const startedAt = Date.now();

	try {
		// Wait for the exit sentinel, streaming a tail to the parent UI.
		while (true) {
			if (signal?.aborted) throw new Error("Subagent aborted");
			if (fs.existsSync(exitFile)) break;
			if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
				await killPane(paneId);
				return {
					text: readFinalText(rawFile),
					changes: await gitSummary(cwd),
					exitCode: null,
					paneId,
					runDir,
					timedOut: true,
				};
			}
			if (onUpdate && fs.existsSync(rawFile)) {
				onUpdate(readFinalText(rawFile));
			}
			await sleep(POLL_MS);
		}

		const exitCode = Number.parseInt(fs.readFileSync(exitFile, "utf-8").trim(), 10);
		return {
			text: readFinalText(rawFile),
			changes: await gitSummary(cwd),
			exitCode: Number.isNaN(exitCode) ? null : exitCode,
			paneId,
			runDir,
			timedOut: false,
		};
	} catch (error) {
		await killPane(paneId);
		throw error;
	}
}
