/**
 * Subagent lifecycle: build a run directory, launch a real interactive pi
 * session in a tmux pane, and hand messages to and from it.
 *
 * Always background: the caller gets a run id immediately. The child hook
 * writes result.json when it settles and a parent-side watcher posts the
 * result as a follow-up notification.
 *
 * Parent -> child steering pastes into the child's live pane; Pi queues the
 * input as steering when the child is mid-turn. If the pane is gone the run is
 * relaunched with the same session id and the task is passed as the prompt.
 *
 * Module split: shell.ts (quoting + pi resolution), child.ts (settle hook +
 * keep-alive + parent paste), tmux.ts (pane allocation), changes.ts (git summary),
 * commands.ts (commands), index.ts (tool + wiring).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { gitSummary } from "./changes.ts";
import { piInvocation, shellQuote } from "./shell.ts";
import { acquirePane, currentSession, focusPane, killPane, paneExists, sendTask } from "./tmux.ts";

const MAX_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const POLL_MS = 400;

/** Nested subagents stop spawning at this depth (root session = 0). */
export const MAX_SUBAGENT_DEPTH = 4;

export interface RunHandle {
	agent: string;
	runId: string;
	status: "running";
	paneId: string;
	runDir: string;
}

export interface SubagentStatus {
	runId: string;
	agent: string;
	status: "running" | "done" | "failed";
	task: string;
	text?: string;
	changes?: string;
	paneId?: string;
	finishedAt?: string;
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
	/** Epoch ms when the settling turn started, so a pre-send result can be told apart. */
	turnStartedAt?: number;
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

/** Move a previous result aside so a new wait cannot see it, without losing it. */
function archiveResult(runDir: string): void {
	const resultPath = path.join(runDir, "result.json");
	if (!fs.existsSync(resultPath)) return;
	try {
		fs.renameSync(resultPath, path.join(runDir, `result.${Date.now()}.json`));
	} catch {
		/* best-effort */
	}
}

/** Atomically record when a follow-up was sent so a pre-send result is not reported as the reply. */
function writeSent(runDir: string): void {
	const tmp = path.join(runDir, `sent.${process.pid}.json`);
	try {
		fs.writeFileSync(tmp, JSON.stringify({ sentAt: Date.now() }), { mode: 0o600 });
		fs.renameSync(tmp, path.join(runDir, "sent.json"));
	} catch {
		/* best-effort */
	}
}

/** Pane id of a run's live session, persisted so a follow-up can continue in it. */
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
	// Empty when the pane is relaunched only to receive the pasted task as its prompt.
	if (task) args.push("--", task);

	const runDir = runDirFor(meta.runId);
	const argv = [invocation.command, ...args].map(shellQuote).join(" ");
	return `${paneEnvPrefix(runDir, meta.depth)} ${argv} 2>${shellQuote(path.join(runDir, "stderr.log"))}`;
}

function assertTmux(): void {
	if (!process.env.TMUX) {
		throw new Error("pi-subagents requires tmux ($TMUX is not set). Run pi inside a tmux session.");
	}
}

function buildRunMetadata(options: {
	ctx: ExtensionContext;
	agent: AgentConfig;
	task: string;
	cwd: string;
	depth: number;
	runId: string;
}): RunMetadata {
	const { ctx, agent, task, cwd, depth, runId } = options;
	const runDir = runDirFor(runId);
	const prompt = agent.systemPrompt.trim();
	const promptPath = prompt ? path.join(runDir, "prompt.md") : undefined;
	if (promptPath) fs.writeFileSync(promptPath, prompt, { encoding: "utf-8", mode: 0o600 });
	return {
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
}

function prepareRunDir(runId: string): string {
	const runDir = runDirFor(runId);
	fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
	pruneRuns(runsDir());
	return runDir;
}

function runIdForAgent(agentName: string): string {
	return `${safeRunName(agentName)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Launch a subagent in a new tmux pane and return immediately. */
export async function runSubagentBackground(options: {
	ctx: ExtensionContext;
	agent: AgentConfig;
	task: string;
	cwd?: string;
	depth: number;
}): Promise<RunHandle> {
	const { ctx, agent, task, depth } = options;
	const cwd = options.cwd ?? ctx.cwd;

	if (!task.trim()) throw new Error("A task is required to start a subagent.");
	assertTmux();
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Subagent cwd does not exist or is not a directory: ${cwd}`);
	}

	const runId = runIdForAgent(agent.name);
	prepareRunDir(runId);
	const meta = buildRunMetadata({ ctx, agent, task, cwd, depth, runId });
	const runDir = runDirFor(runId);
	fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(meta, null, 2), { mode: 0o600 });

	fs.rmSync(path.join(runDir, "stderr.log"), { force: true });
	const command = launchCommand(meta, task);
	try {
		const session = await currentSession();
		const paneId = await acquirePane({ session, cwd: meta.cwd, command, title: `pi:${meta.agent}` });
		writePaneId(runDir, paneId);
		return { runId, agent: agent.name, status: "running", paneId, runDir };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeTerminalResult(runDir, "failed", message);
		throw new Error(`Failed to launch subagent pane: ${message}`, { cause: error });
	}
}

const runLocks = new Map<string, Promise<unknown>>();

function withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
	const previous = runLocks.get(runId) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	runLocks.set(runId, run);
	return run.finally(() => {
		if (runLocks.get(runId) === run) runLocks.delete(runId);
	});
}

/**
 * Send a message to an existing run by pasting it into the child's pane, which
 * Pi queues as steering when the child is mid-turn. If the pane is gone the run
 * is relaunched with the same session id and the task is passed as the prompt.
 */
export function sendToRun(options: { runId: string; task: string; depth: number }): Promise<RunHandle> {
	return withRunLock(options.runId, async () => {
		const { runId, task, depth } = options;
		assertTmux();
		if (!validRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
		const runDir = runDirFor(runId);
		const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
		if (!meta) throw new Error(`No subagent run found for "${runId}".`);
		// The directory name is the authoritative id; a tampered run.json must not
		// redirect the poll/shell paths outside runs/<runId>.
		if (meta.runId !== runId) throw new Error(`Run metadata for "${runId}" is invalid.`);
		if (!fs.statSync(meta.cwd, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`Subagent cwd does not exist or is not a directory: ${meta.cwd}`);
		}

		if (!task.trim()) throw new Error("A message is required.");
		// A new message means new work: drop the old terminal result before sending.
		archiveResult(runDir);
		writeSent(runDir);
		const existing = readPaneId(runDir);
		let paneId: string | undefined;
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
		if (!paneId) {
			const command = launchCommand({ ...meta, runId, depth, task }, task);
			try {
				const session = await currentSession();
				paneId = await acquirePane({ session, cwd: meta.cwd, command, title: `pi:${meta.agent}` });
				writePaneId(runDir, paneId);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				writeTerminalResult(runDir, "failed", message);
				throw new Error(`Failed to launch subagent pane: ${message}`, { cause: error });
			}
		}
		return { runId, agent: meta.agent, status: "running", paneId, runDir };
	});
}

export async function cancelSubagent(runId: string): Promise<void> {
	assertTmux();
	if (!validRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
	const runDir = runDirFor(runId);
	const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
	if (!meta) throw new Error(`No subagent run found for "${runId}".`);
	if (meta.runId !== runId) throw new Error(`Run metadata for "${runId}" is invalid.`);

	const paneId = readPaneId(runDir);
	if (paneId) await killPane(paneId);
	// Preserve an already completed result rather than overwriting it with "Cancelled".
	if (readJson<ChildResult>(path.join(runDir, "result.json"))) archiveResult(runDir);
	const text = readStderrTail(runDir);
	writeTerminalResult(runDir, "failed", text || "Cancelled");
	stopBackgroundWatcher(runId);
}

export async function getSubagentStatus(runId: string): Promise<SubagentStatus> {
	if (!validRunId(runId)) throw new Error(`Invalid run id: ${runId}`);
	const runDir = runDirFor(runId);
	const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
	if (!meta) throw new Error(`No subagent run found for "${runId}".`);
	const result = readJson<ChildResult>(path.join(runDir, "result.json"));
	const paneId = readPaneId(runDir);
	if (result) {
		return {
			runId,
			agent: meta.agent,
			status: result.status === "failed" ? "failed" : "done",
			task: meta.task,
			text: typeof result.text === "string" ? result.text : undefined,
			changes: await gitSummary(meta.cwd).catch(() => undefined),
			paneId,
			finishedAt: result.finishedAt,
		};
	}
	return { runId, agent: meta.agent, status: "running", task: meta.task, paneId };
}

// ---- Background run watchers ----

const backgroundWatchers = new Map<string, NodeJS.Timeout>();

function formatResultMessage(meta: RunMetadata, result: ChildResult, runDir: string): string {
	const sections: string[] = [];
	const text = typeof result.text === "string" && result.text.trim() ? result.text : readStderrTail(runDir);
	if (text.trim()) sections.push(text.trim());
	// Best-effort; do not block the notification on git IO.
	const changes = gitSummarySync(meta.cwd);
	if (changes) sections.push(`Changed files:\n${changes}`);
	const header = result.status === "failed" ? `**${meta.agent}** failed` : `**${meta.agent}** completed`;
	return [header, "", ...sections].join("\n") || `${header}.`;
}

function gitSummarySync(cwd: string): string {
	// Synchronous fallback for the notification path; ignores errors and keeps
	// git's stderr out of the terminal when cwd is not a repository.
	try {
		return execFileSync("git", ["-C", cwd, "status", "--short"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

/** True when a result predates the most recent follow-up send (an old turn's settle). */
function resultIsStale(result: ChildResult, sentAt: number | undefined): boolean {
	if (typeof sentAt !== "number") return false;
	return typeof result.turnStartedAt === "number" ? result.turnStartedAt < sentAt : Date.parse(result.finishedAt) < sentAt;
}

/** Watch a run's result.json and post a follow-up notification when it appears. */
export function startBackgroundWatcher(pi: ExtensionAPI, runId: string): void {
	if (backgroundWatchers.has(runId)) return;
	const runDir = runDirFor(runId);
	let paneMisses = 0;
	let paneCheckInFlight = false;
	const failOnDeadPane = (): void => {
		stopBackgroundWatcher(runId);
		const text = readStderrTail(runDir);
		writeTerminalResult(runDir, "failed", text);
		const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
		if (meta) {
			const reason = text.trim() ? `pane exited:\n${text}` : "pane exited before reporting a result";
			pi.sendMessage(
				{
					customType: "pi-subagents",
					content: `**${meta.agent}** failed: ${reason}`,
					display: true,
					details: { agent: meta.agent, runId, error: "pane exited" },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
	};
	const timer = setInterval(() => {
		const result = readJson<ChildResult>(path.join(runDir, "result.json"));
		if (result) {
			const sent = readJson<{ sentAt?: number }>(path.join(runDir, "sent.json"));
			if (resultIsStale(result, sent?.sentAt)) {
				// This settle happened before the last follow-up send. Clear it and fall
				// through to the pane check so we neither report it nor loop on it forever.
				archiveResult(runDir);
			} else {
				stopBackgroundWatcher(runId);
				const meta = readJson<RunMetadata>(path.join(runDir, "run.json"));
				if (meta) {
					pi.sendMessage(
						{
							customType: "pi-subagents",
							content: formatResultMessage(meta, result, runDir),
							display: true,
							details: { agent: meta.agent, runId, status: result.status },
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				}
				return;
			}
		}
		if (paneCheckInFlight) return;
		paneCheckInFlight = true;
		const paneId = readPaneId(runDir);
		void (paneId ? paneExists(paneId) : Promise.resolve(false)).then((exists) => {
			paneCheckInFlight = false;
			if (backgroundWatchers.get(runId) !== timer) return;
			if (exists) {
				paneMisses = 0;
				return;
			}
			paneMisses++;
			// Require a few consecutive misses to avoid false alarms during tmux
			// bookkeeping; a truly dead pane stays gone across ~1.2s of polls.
			if (paneMisses < 3) return;
			failOnDeadPane();
		});
	}, POLL_MS);
	backgroundWatchers.set(runId, timer);
}

function stopBackgroundWatcher(runId: string): void {
	const timer = backgroundWatchers.get(runId);
	if (timer) {
		clearInterval(timer);
		backgroundWatchers.delete(runId);
	}
}

export function stopAllBackgroundWatchers(): void {
	for (const [runId, timer] of backgroundWatchers) {
		clearInterval(timer);
		backgroundWatchers.delete(runId);
	}
}

export async function restoreBackgroundWatchers(pi: ExtensionAPI): Promise<void> {
	for (const run of listRuns(100)) {
		if (run.status !== "running") continue;
		const runDir = runDirFor(run.runId);
		const paneId = readPaneId(runDir);
		// Only watch runs whose pane is still alive. A pane that died without
		// writing a result is a stale crash from a previous session; mark it
		// failed silently so it does not spam notifications on every reload.
		if (!paneId || !(await paneExists(paneId))) {
			writeTerminalResult(runDir, "failed", readStderrTail(runDir) || "Pane exited before reporting a result");
			continue;
		}
		startBackgroundWatcher(pi, run.runId);
	}
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
	if (!fs.statSync(meta.cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Subagent cwd does not exist or is not a directory: ${meta.cwd}`);
	}
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
