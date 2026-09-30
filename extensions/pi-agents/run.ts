/**
 * Subagent runner: build a run directory, launch `pi --mode json -p` in a tmux
 * pane, wait for exit, and collect the final text + file changes.
 *
 * The pane shows a human-readable stream (via jq); raw.jsonl keeps the
 * structured event stream for the parent.
 *
 * Module split: script.ts (run.sh generation), jsonl.ts (raw.jsonl parsing),
 * tmux.ts (pane allocation), changes.ts (git summary), index.ts (tool + commands).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { gitSummary } from "./changes.ts";
import { readFinalText, readRange, type RawEvent } from "./jsonl.ts";
import { buildRunScript, piInvocation, safeRunName } from "./script.ts";
import { acquirePane, currentSession, killPane, paneExists } from "./tmux.ts";

const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 400;
/** How often to check the pane still exists (every N polls). */
const PANE_CHECK_EVERY = 12;
const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RunResult {
	text: string;
	changes: string;
	exitCode: number | null;
	paneId: string | null;
	runDir: string;
	timedOut: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delete stale run directories so runs/ does not grow forever. */
function pruneRuns(runsDir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(runsDir, entry.name);
		try {
			if (now - fs.statSync(dir).mtimeMs > MAX_RUN_AGE_MS) fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			/* in use or gone */
		}
	}
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

	if (!process.env.TMUX) {
		throw new Error("pi-agents requires tmux ($TMUX is not set). Run pi inside a tmux session.");
	}
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Subagent cwd does not exist or is not a directory: ${cwd}`);
	}

	const runId = `${safeRunName(agent.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const runDir = path.join(getAgentDir(), "pi-agents", "runs", runId);
	fs.mkdirSync(runDir, { recursive: true });
	pruneRuns(path.dirname(runDir));

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

	const scriptPath = buildRunScript(runDir, cwd, command, args);

	const session = await currentSession();
	const paneId = await acquirePane({ session, cwd, scriptPath, title: `pi:${agent.name}` });

	const exitFile = path.join(runDir, "exit");
	const rawFile = path.join(runDir, "raw.jsonl");
	const startedAt = Date.now();

	// Incremental tail: parse only bytes appended since the previous poll,
	// splitting on complete lines so a truncated (possibly mid-codepoint) read
	// never corrupts the byte offset.
	let scanOffset = 0;
	let carry = Buffer.alloc(0);
	let streamedText = "";
	const pollStream = (): void => {
		const chunk = readRange(rawFile, scanOffset);
		if (!chunk) return;
		scanOffset += chunk.length;
		const buffer = Buffer.concat([carry, chunk]);
		const lastNewline = buffer.lastIndexOf("\n");
		if (lastNewline === -1) {
			carry = buffer;
			return;
		}
		carry = buffer.subarray(lastNewline + 1);
		for (const line of buffer.subarray(0, lastNewline + 1).toString("utf-8").split("\n")) {
			if (!line.trim()) continue;
			let event: RawEvent;
			try {
				event = JSON.parse(line) as RawEvent;
			} catch {
				continue;
			}
			// A tool-only turn produces no assistant text; clear so the progress
			// line does not keep showing a previous turn's output.
			if (event.type === "message_start" && event.message?.role === "assistant") streamedText = "";
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const parts = (event.message.content ?? [])
					.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("");
				if (parts) streamedText = parts;
			}
		}
	};

	try {
		// Wait for the exit sentinel, streaming a tail to the parent UI.
		for (let poll = 0; ; poll++) {
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
			// A closed pane never writes the sentinel; fail in seconds, not minutes.
			if (poll > 0 && poll % PANE_CHECK_EVERY === 0 && !(await paneExists(paneId))) {
				return {
					text: readFinalText(rawFile),
					changes: await gitSummary(cwd),
					exitCode: 1,
					paneId,
					runDir,
					timedOut: false,
				};
			}
			if (onUpdate) {
				pollStream();
				onUpdate(streamedText || "(running...)");
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
