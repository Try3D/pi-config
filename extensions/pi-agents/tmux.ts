/**
 * tmux primitives for pi-agents.
 *
 * Strictly uses the CURRENT tmux session. Subagents share tabs of up to
 * MAX_PANES_PER_WINDOW tiled panes each; overflow opens the next tab. Owned
 * windows carry the `@pi-agents` user option, so the extension never takes over
 * a user window named `agents`.
 */

import { execFile } from "node:child_process";
import { shellQuote } from "./script.ts";

const MAX_PANES_PER_WINDOW = 4;
const WINDOW_RE = /^agents(-\d+)?$/;
const TMUX_TIMEOUT_MS = 10_000;

function tmux(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { encoding: "utf-8", timeout: TMUX_TIMEOUT_MS }, (error, stdout, stderr) => {
			if (error) reject(new Error(`tmux ${args.join(" ")}: ${stderr || error.message}`));
			else resolve(stdout);
		});
	});
}

export async function currentSession(): Promise<string> {
	return (await tmux(["display-message", "-p", "#{session_name}"])).trim();
}

interface WindowInfo {
	id: string;
	name: string;
	panes: number;
}

async function listAgentWindows(session: string): Promise<WindowInfo[]> {
	const out = await tmux([
		"list-windows",
		"-t",
		session,
		"-F",
		"#{window_id}\t#{window_name}\t#{window_panes}\t#{@pi-agents}",
	]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id = "", name = "", panes = "", tag = ""] = line.split("\t");
			return { id, name, panes: Number(panes), owned: tag === "1" };
		})
		.filter((w) => w.owned || WINDOW_RE.test(w.name))
		.filter((w) => Number.isFinite(w.panes))
		.map(({ id, name, panes }) => ({ id, name, panes }));
}

async function nextWindowName(session: string): Promise<string> {
	const used = new Set((await listAgentWindows(session)).map((w) => w.name));
	if (!used.has("agents")) return "agents";
	for (let i = 2; ; i++) if (!used.has(`agents-${i}`)) return `agents-${i}`;
}

// Serialize allocation so concurrent subagent calls can't race past the cap.
// Per-process only: concurrent pi processes each have their own lock and can
// still collectively exceed MAX_PANES_PER_WINDOW (best-effort, fine for the
// 4-per-tab tiling which just re-wraps to the next window).
let allocation: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = allocation.then(fn, fn);
	allocation = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * Acquire a pane for a subagent: fill an existing `agents*` window with
 * capacity, else open a new tab. The pane runs `bash <scriptPath>`.
 */
export async function acquirePane(options: {
	session: string;
	cwd: string;
	scriptPath: string;
	title?: string;
}): Promise<string> {
	const { session, cwd, scriptPath, title } = options;
	const command = `bash ${shellQuote(scriptPath)}`;

	return withLock(async () => {
		const window = (await listAgentWindows(session)).find((w) => w.panes < MAX_PANES_PER_WINDOW);
		let paneId: string;
		if (window) {
			paneId = (
				await tmux(["split-window", "-t", window.id, "-P", "-F", "#{pane_id}", "-c", cwd, command])
			).trim();
			await tmux(["select-layout", "-t", window.id, "tiled"]);
		} else {
			const name = await nextWindowName(session);
			const [newPane = "", windowId = ""] = (
				await tmux([
					"new-window",
					"-d",
					"-P",
					"-F",
					"#{pane_id}\t#{window_id}",
					"-t",
					session,
					"-n",
					name,
					"-c",
					cwd,
					command,
				])
			)
				.trim()
				.split("\t");
			paneId = newPane;			// Tag ownership so the extension (and future runs) only reuse its own tabs.
			await tmux(["set-window-option", "-t", windowId, "@pi-agents", "1"]).catch(() => {});
		}
		if (title) await tmux(["select-pane", "-t", paneId, "-T", title]).catch(() => {});
		return paneId;
	});
}

export async function killPane(paneId: string): Promise<void> {
	try {
		await tmux(["kill-pane", "-t", paneId]);
	} catch {
		/* already gone */
	}
}

/** Whether a pane still exists (used to fail fast when the user closes it). */
export async function paneExists(paneId: string): Promise<boolean> {
	try {
		await tmux(["list-panes", "-t", paneId, "-F", "#{pane_id}"]);
		return true;
	} catch {
		return false;
	}
}
