/**
 * tmux pane operations for pi-subagents.
 *
 * Strictly uses the CURRENT tmux session. Each subagent gets its own window
 * (tab) with a single pane: windows are appended at the end (rightmost) and
 * named `_1`, `_2`, `_3`, …. The window is the subagent's pane and the unit of
 * cleanup, so there is no tiling or window reuse.
 */

import { execFile } from "node:child_process";

const TMUX_TIMEOUT_MS = 10_000;
/** Short wait for the allocation lock so a stale lock cannot stall a launch for long. */
const LOCK_TIMEOUT_MS = 3_000;

function tmux(args: string[], timeout = TMUX_TIMEOUT_MS): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { encoding: "utf-8", timeout }, (error, stdout, stderr) => {
			if (error) reject(new Error(`tmux ${args.join(" ")}: ${stderr || error.message}`));
			else resolve(stdout);
		});
	});
}

export async function currentSession(): Promise<string> {
	return (await tmux(["display-message", "-p", "#{session_name}"])).trim();
}

/** Smallest `_N` not already used by any window in the session. */
async function nextWindowName(session: string): Promise<string> {
	const used = new Set(
		(await tmux(["list-windows", "-t", session, "-F", "#{window_name}"])).split("\n").filter(Boolean),
	);
	for (let i = 1; ; i++) if (!used.has(`_${i}`)) return `_${i}`;
}

// Serialize allocation so concurrent subagent calls can't race to the same name.
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
 * Cross-process lock channel. Nested subagents run in separate pi processes that
 * allocate at the same time; the in-process lock cannot stop them from picking
 * the same `_N`. tmux's `wait-for -L/-U` is a server-wide mutex (held until `-U`,
 * even after the locking client exits).
 */
const ALLOC_LOCK = "pi-subagents-alloc";

/**
 * Try to get the cross-process lock. A timeout may mean a live process holds it,
 * so proceed unlocked rather than risk releasing another process's lock. A
 * duplicate `_N` is cosmetic. Later launches should not stall indefinitely.
 */
async function lockAlloc(): Promise<boolean> {
	try {
		await tmux(["wait-for", "-L", ALLOC_LOCK], LOCK_TIMEOUT_MS);
		return true;
	} catch {
		return false;
	}
}

/**
 * Acquire a pane for a subagent: open a new tab at the end of the window list.
 * `command` is a full shell command string, run by tmux in the new pane.
 */
export async function acquirePane(options: {
	session: string;
	cwd: string;
	command: string;
	title?: string;
}): Promise<string> {
	const { session, cwd, command, title } = options;

	return withLock(async () => {
		const locked = await lockAlloc();
		try {
			const name = await nextWindowName(session);
			const paneId = (
				await tmux([
					"new-window",
					"-d",
					// Insert after the last window so the tab lands at the far right.
					"-a",
					"-P",
					"-F",
					"#{pane_id}",
					"-t",
					`${session}:{end}`,
					"-n",
					name,
					"-c",
					cwd,
					command,
				])
			).trim();
			// Prefix the pane title with the tab id (`_N`) so pane borders, the tab
			// bar, and the sidebar all name the subagent the same way.
			if (title) await tmux(["select-pane", "-t", paneId, "-T", `${name} ${title}`]).catch(() => {});
			return paneId;
		} finally {
			if (locked) await tmux(["wait-for", "-U", ALLOC_LOCK]).catch(() => {});
		}
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
	} catch (error) {
		// Only a definitive "no such pane" means gone; a timeout or busy server
		// must not be reported as a crashed (but still running) child.
		return !/can't find pane|no such pane|pane not found/i.test(error instanceof Error ? error.message : "");
	}
}

/** Monotonic suffix so each send gets its own tmux buffer. */
let sendSeq = 0;

/** Paste a whole task into a live subagent pane as one bracketed paste, then submit it. */
export async function sendTask(paneId: string, taskFile: string): Promise<void> {
	// tmux buffers are server-global, so a shared default buffer could be
	// overwritten or deleted by a concurrent send; use a unique name.
	const buffer = `pi-subagents-${process.pid}-${++sendSeq}`;
	await tmux(["load-buffer", "-b", buffer, taskFile]);
	try {
		// `-p` wraps the buffer in bracketed-paste codes so the TUI receives the
		// whole task as one paste. Without it tmux replaces each LF with CR (Enter)
		// and every line is submitted as its own message.
		await tmux(["paste-buffer", "-p", "-b", buffer, "-t", paneId]);
	} finally {
		await tmux(["delete-buffer", "-b", buffer]).catch(() => undefined);
	}
	// Let the TUI ingest the paste before submitting.
	await new Promise((resolve) => setTimeout(resolve, 150));
	await tmux(["send-keys", "-t", paneId, "Enter"]);
}

/** Switch the current client to the pane's window and make it active. */
export async function focusPane(paneId: string): Promise<void> {
	const [session = "", window = ""] = (
		await tmux(["display-message", "-p", "-t", paneId, "#{session_id}\t#{window_id}"]).catch(() => "")
	)
		.trim()
		.split("\t");
	if (session) await tmux(["switch-client", "-t", session]).catch(() => undefined);
	if (window) await tmux(["select-window", "-t", window]).catch(() => undefined);
	await tmux(["select-pane", "-t", paneId]).catch(() => undefined);
}
