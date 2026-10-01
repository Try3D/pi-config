/**
 * Subagent lifecycle: build a run directory, launch a real interactive pi
 * session in a tmux pane, wait for the child to report completion, and collect
 * the final text plus a git change summary.
 *
 * The child runs the full pi TUI. Completion is reported by the child hook (see
 * child.ts), which writes result.json and then keeps the pane alive. Module
 * split: shell.ts (quoting + pi resolution), child.ts (settle hook), tmux.ts
 * (pane allocation), changes.ts (git summary), commands.ts (commands), index.ts
 * (tool + wiring).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { gitSummary } from "./changes.ts";
import { piInvocation, shellQuote } from "./shell.ts";
import { acquirePane, currentSession, focusPane, killPane, paneExists, sendTask } from "./tmux.ts";

const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 400;
/** How often to check the pane still exists (every N polls). */
const PANE_CHECK_EVERY = 12;
const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Nested subagents stop spawning at this depth (root session = 0). */
export const MAX_SUBAGENT_DEPTH = 4;

export interface RunResult {
	agent: string;
	/** Conversation id: pass it back to continue this subagent's session. */
	runId: string;
	text: string;
	changes: string;
	status: "done" | "failed";
	paneId: string | null;
	runDir: string;
	timedOut: boolean;
}

/** Launch configuration persisted per run so a finished child can be resumed. */
interface RunMetadata {
	runId: string;
	agent: string;
	depth: number;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	promptPath?: string;
	task: string;
	startedAt: string;
}

interface ChildResult {
	status: "done" | "failed";
	text: string;
	finishedAt: string;
}

export interface RunSummary {
	runId: string;
	agent: string;
	task: string;
	status: "running" | "done" | "failed";
	startedAt: string;
}

/** Current nesting depth of this session (0 for a root session). */
export function currentDepth(): number {
	const depth = Number.parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

function validRunId(runId: string): boolean {
	return RUN_ID_RE.test(runId) && runId !== "." && runId !== "..";
}

function runsDir(): string {
	return path.join(getAgentDir(), "pi-subagents", "runs");
}

function runDirFor(runId: string): string {
	return path.join(runsDir(), runId);
}

function readJson<T>(filePath: string): T | null {
	try {
		// `lstat` rejects symlinks and non-regular files (e.g. a planted FIFO that
		// would block the event loop on read).
		if (!fs.lstatSync(filePath, { throwIfNoEntry: false })?.isFile()) return null;
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch {
		return null;
	}
}

/** Write a terminal result so an aborted/crashed run is not shown as "running" forever. */
function writeTerminalResult(runDir: string, status: "done" | "failed", text: string): void {
	try {
		fs.writeFileSync(
			path.join(runDir, "result.json"),
			JSON.stringify({ status, text, finishedAt: new Date().toISOString() }, null, 2),
			{ mode: 0o600 },
		);
	} catch {
		/* best-effort */
	}
}

/** Move a previous result aside so a resume wait cannot see it, without losing it. */
function archiveResult(runDir: string): void {
	const resultPath = path.join(runDir, "result.json");
	if (!fs.existsSync(resultPath)) return;
	try {
		fs.renameSync(resultPath, path.join(runDir, `result.${Date.now()}.json`));
	} catch {
		/* best-effort */
	}
}

/** Pane id of a run's live session, persisted so a resume can continue in it. */
function readPaneId(runDir: string): string | undefined {
	try {
		const pane = fs.readFileSync(path.join(runDir, "pane"), "utf-8").trim();
		return /^%\d+$/.test(pane) ? pane : undefined;
	} catch {
		return undefined;
	}
}

function writePaneId(runDir: string, paneId: string): void {
	try {
		fs.writeFileSync(path.join(runDir, "pane"), paneId, { mode: 0o600 });
	} catch {
		/* best-effort */
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Agent names come from frontmatter and must not move outside runs/. */
function safeRunName(name: string): string {
	return name.replace(/^\.+/, "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "agent";
}

/** Delete stale run directories so runs/ does not grow forever. */
function pruneRuns(dir: string): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.isDirectory() || !validRunId(entry.name)) continue;
		const entryPath = path.join(dir, entry.name);
		try {
			if (now - fs.statSync(entryPath).mtimeMs > MAX_RUN_AGE_MS) fs.rmSync(entryPath, { recursive: true, force: true });
		} catch {
			/* in use or gone */
		}
	}
}

function readStderrTail(runDir: string, maxChars = 2000): string {
	const file = path.join(runDir, "stderr.log");
	try {
		const stat = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!stat?.isFile()) return "";
		// Read only the tail so a chatty child cannot force an unbounded read.
		const length = Math.min(stat.size, 8192);
		const fd = fs.openSync(file, "r");
		try {
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
			const tail = buffer.toString("utf-8").trim();
			return tail ? `stderr:\n${tail.slice(-maxChars)}` : "";
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** Env for a child pane. tmux panes see the server env, not ours, so pass everything explicitly. */
function paneEnvPrefix(runDir: string, depth: number): string {
	const env: Record<string, string> = {
		PI_SUBAGENT_RUN_DIR: runDir,
		PI_SUBAGENT_DEPTH: String(depth),
		// Lets the sidebar build the subagent tree (which pane spawned which).
		PI_SUBAGENT_PARENT_PID: String(process.pid),
	};
	const keepAlive = process.env.PI_SUBAGENT_KEEPALIVE_MS;
	if (keepAlive) env.PI_SUBAGENT_KEEPALIVE_MS = keepAlive;
	return Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
}

/** Full shell command tmux runs in the pane: env prefix, pi argv, stderr log. */
function launchCommand(meta: RunMetadata, task: string): string {
	const invocation = piInvocation();
	const args = [...invocation.prefixArgs, "--session-id", meta.runId];
	// The sidebar shows the subagent icon and `_N` tab id, so the session name uses
	// the task instead of the `[agent:...]` prefix. Use the agent name if the task is empty.
	args.push("--name", task.replace(/\s+/g, " ").trim().slice(0, 60) || meta.agent);
	if (meta.model) args.push("--model", meta.model);
	if (meta.thinking) args.push("--thinking", meta.thinking);
	if (meta.tools?.length) args.push("--tools", meta.tools.join(","));
	if (meta.promptPath) args.push("--append-system-prompt", meta.promptPath);
	args.push(task);

	const runDir = runDirFor(meta.runId);
	const argv = [invocation.command, ...args].map(shellQuote).join(" ");
	return `${paneEnvPrefix(runDir, meta.depth)} ${argv} 2>${shellQuote(path.join(runDir, "stderr.log"))}`;
}

/** Launch a pane and wait for the child hook to report completion. */
async function waitForRun(options: {
	meta: RunMetadata;
	task: string;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	/** Continue in the run's still-live pane instead of opening another window. */
	reusePane?: boolean;
}): Promise<RunResult> {
	const { meta, task, signal, onUpdate, reusePane } = options;
	const runDir = runDirFor(meta.runId);

	// Resume into the existing pane when it is still alive; otherwise (first run,
	// pane closed, or it died between the check and the paste) open a new one.
	let paneId: string | undefined;
	if (reusePane) {
		const existing = readPaneId(runDir);
		if (existing && (await paneExists(existing))) {
			try {
				const taskFile = path.join(runDir, "task.txt");
				fs.writeFileSync(taskFile, task, { mode: 0o600 });
				await sendTask(existing, taskFile);
				paneId = existing;
			} catch (error) {
				if (await paneExists(existing)) throw error;
				paneId = undefined;
			}
		}
	}
	if (!paneId) {
		// Drop any planted stderr.log (e.g. a symlink) before the shell opens it with `2>`.
		fs.rmSync(path.join(runDir, "stderr.log"), { force: true });
		const command = launchCommand(meta, task);
		const session = await currentSession();
		paneId = await acquirePane({ session, cwd: meta.cwd, command, title: `pi:${meta.agent}` });
		writePaneId(runDir, paneId);
	}

	const resultPath = path.join(runDir, "result.json");
	const startedAt = Date.now();

	try {
		for (let poll = 0; ; poll++) {
			if (signal?.aborted) throw new Error("Subagent aborted");
			const result = readJson<ChildResult>(resultPath);
			if (result) {
				return {
					agent: meta.agent,
					runId: meta.runId,
					text: typeof result.text === "string" ? result.text : readStderrTail(runDir),
					changes: await gitSummary(meta.cwd),
					status: result.status === "failed" ? "failed" : "done",
					paneId,
					runDir,
					timedOut: false,
				};
			}
			// A crashed pane never writes a result; fail in seconds, not minutes.
			if (poll > 0 && poll % PANE_CHECK_EVERY === 0 && !(await paneExists(paneId))) {
				const text = readStderrTail(runDir);
				writeTerminalResult(runDir, "failed", text);
				return {
					agent: meta.agent,
					runId: meta.runId,
					text,
					changes: await gitSummary(meta.cwd),
					status: "failed",
					paneId,
					runDir,
					timedOut: false,
				};
			}
			if (Date.now() - startedAt > WAIT_TIMEOUT_MS) {
				await killPane(paneId);
				const text = readStderrTail(runDir);
				writeTerminalResult(runDir, "failed", text);
				return { agent: meta.agent, runId: meta.runId, text, changes: await gitSummary(meta.cwd), status: "failed", paneId, runDir, timedOut: true };
			}
			onUpdate?.(`${meta.agent} is working…`);
			await sleep(POLL_MS);
		}
	} catch (error) {
		await killPane(paneId);
		throw error;
	}
}

function assertTmux(): void {
	if (!process.env.TMUX) {
		throw new Error("pi-subagents requires tmux ($TMUX is not set). Run pi inside a tmux session.");
	}
}

export async function runSubagent(options: {
	ctx: ExtensionContext;
	agent: AgentConfig;
	task: string;
	cwd?: string;
	depth: number;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<RunResult> {
	const { ctx, agent, task, depth, signal, onUpdate } = options;
	const cwd = options.cwd ?? ctx.cwd;

	assertTmux();
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Subagent cwd does not exist or is not a directory: ${cwd}`);
	}

	const runId = `${safeRunName(agent.name)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const runDir = runDirFor(runId);
	fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
	pruneRuns(runsDir());

	const prompt = agent.systemPrompt.trim();
	const promptPath = prompt ? path.join(runDir, "prompt.md") : undefined;
	if (promptPath) fs.writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });

	const meta: RunMetadata = {
		runId,
		agent: agent.name,
		depth,
		cwd,
		model: agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
		thinking: ctx.thinkingLevel,
		tools: agent.tools,
		promptPath,
		task,
		startedAt: new Date().toISOString(),
	};
	fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });

	try {
		return await waitForRun({ meta, task, signal, onUpdate });
	} catch (error) {
		writeTerminalResult(runDir, "failed", error instanceof Error ? error.message : String(error));
		throw error;
	}
}

const resumeLocks = new Map<string, Promise<unknown>>();

function withResumeLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
	const previous = resumeLocks.get(runId) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	resumeLocks.set(runId, run);
	return run.finally(() => {
		if (resumeLocks.get(runId) === run) resumeLocks.delete(runId);
	});
}

export function resumeSubagent(options: {
	ctx: ExtensionContext;
	runId: string;
	task: string;
	depth: number;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
}): Promise<RunResult> {
	return withResumeLock(options.runId, async () => {
		const { runId, task, depth, signal, onUpdate } = options;
		if (signal?.aborted) throw new Error("Subagent aborted");
		assertTmux();
		if (!validRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
		const runDir = runDirFor(runId);
		const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
		if (!meta) throw new Error(`No subagent run found for "${runId}".`);
		// The directory name is the authoritative id; a tampered run.json must not
		// redirect the poll/shell paths outside runs/<runId>.
		if (meta.runId !== runId) throw new Error(`Run metadata for "${runId}" is invalid.`);
		if (!fs.statSync(meta.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Subagent cwd does not exist or is not a directory: ${meta.cwd}`);
		// Preserve the previous result (it would otherwise satisfy the wait) rather than delete it.
		archiveResult(runDir);
		try {
			return await waitForRun({ meta: { ...meta, runId, depth, task }, task, signal, onUpdate, reusePane: true });
		} catch (error) {
			writeTerminalResult(runDir, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		}
	});
}

/** Recent runs, newest first. */
export function listRuns(limit = 20): RunSummary[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsDir(), { withFileTypes: true });
	} catch {
		return [];
	}
	const runs: RunSummary[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !validRunId(entry.name)) continue;
		const meta = readJson<RunMetadata>(path.join(runsDir(), entry.name, "run.json"));
		if (!meta) continue;
		const result = readJson<ChildResult>(path.join(runsDir(), entry.name, "result.json"));
		runs.push({
			runId: entry.name,
			agent: typeof meta.agent === "string" ? meta.agent : "?",
			task: typeof meta.task === "string" ? meta.task : "",
			status: result ? (result.status === "failed" ? "failed" : "done") : "running",
			startedAt: typeof meta.startedAt === "string" ? meta.startedAt : "",
		});
	}
	runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	return runs.slice(0, limit);
}

/** Reopen a past run's session in a new pane (no task; the user drives it). */
export async function openRunSession(runId: string, depth: number): Promise<string> {
	assertTmux();
	if (!validRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
	const runDir = runDirFor(runId);
	const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
	if (!meta) throw new Error(`No subagent run found for "${runId}".`);
	if (meta.runId !== runId) throw new Error(`Run metadata for "${runId}" is invalid.`);
	if (!fs.statSync(meta.cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Subagent cwd does not exist or is not a directory: ${meta.cwd}`);
	const existing = readPaneId(runDir);
	if (existing && (await paneExists(existing))) {
		await focusPane(existing);
		return existing;
	}

	const invocation = piInvocation();
	const argv = [invocation.command, ...invocation.prefixArgs, "--session-id", runId].map(shellQuote).join(" ");
	const command = `${paneEnvPrefix(runDir, depth)} ${argv} 2>${shellQuote(path.join(runDir, "stderr.log"))}`;
	const session = await currentSession();
	const paneId = await acquirePane({ session, cwd: meta.cwd, command, title: `pi:${meta.agent}` });
	writePaneId(runDir, paneId);
	return paneId;
}
