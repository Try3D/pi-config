/**
 * tmux primitives for pi-agents.
 *
 * Strictly uses the CURRENT tmux session. Subagents share tabs of up to
 * MAX_PANES_PER_WINDOW tiled panes each; overflow opens the next tab.
 */

import { execFile } from "node:child_process";

const MAX_PANES_PER_WINDOW = 4;
const WINDOW_RE = /^agents(-\d+)?$/;

function tmux(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { encoding: "utf-8" }, (error, stdout, stderr) => {
			if (error) reject(new Error(`tmux ${args.join(" ")}: ${stderr || error.message}`));
			else resolve(stdout);
		});
	});
}

export function isInsideTmux(): boolean {
	return Boolean(process.env.TMUX);
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
	const out = await tmux(["list-windows", "-t", session, "-F", "#{window_id}\t#{window_name}\t#{window_panes}"]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id, name, panes] = line.split("\t");
			return { id, name, panes: Number(panes) };
		})
		.filter((w) => WINDOW_RE.test(w.name));
}

async function nextWindowName(session: string): Promise<string> {
	const used = new Set((await listAgentWindows(session)).map((w) => w.name));
	if (!used.has("agents")) return "agents";
	for (let i = 2; ; i++) if (!used.has(`agents-${i}`)) return `agents-${i}`;
}

// Serialize allocation so concurrent subagent calls can't race past the cap.
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
			paneId = (
				await tmux([
					"new-window",
					"-d",
					"-P",
					"-F",
					"#{pane_id}",
					"-t",
					session,
					"-n",
					name,
					"-c",
					cwd,
					command,
				])
			).trim();
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

export async function listPanes(): Promise<string> {
	return tmux(["list-panes", "-a", "-F", "#{session_name}\t#{window_name}\t#{pane_id}\t#{pane_title}"]);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
