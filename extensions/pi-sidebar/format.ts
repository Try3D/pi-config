/**
 * Pure formatting/parsing helpers: ps `etime` values, terminal-title session
 * names, session heuristics, and workspace grouping.
 */

import { basename } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

/** Compact an `etime` value ([[dd-]hh:]mm:ss) to a single unit: `6d`, `2h`, or `5m`. */
export function shortElapsed(etime: string): string {
	const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):\d+$/);
	if (!match) return etime;
	const [, days, hours, minutes] = match;
	if (days) return `${days}d`;
	if (hours) return `${hours}h`;
	return `${minutes}m`;
}

/** Parse a ps `etime` value into elapsed milliseconds, or undefined if unparsable. */
export function elapsedMs(etime: string): number | undefined {
	const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!match) return undefined;
	const [, days, hours, minutes, seconds] = match;
	return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Strip control characters so labels from other processes cannot inject terminal escapes. */
export function sanitize(text: string): string {
	// eslint-disable-next-line no-control-regex -- stripping C0/C1 controls is the point
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/** Session name embedded in the pi terminal title (`pi - name - cwd`). */
export function titleSessionName(title: string): string | undefined {
	const parts = title.split(" - ");
	return parts.length >= 3 ? parts.slice(1, -1).join(" - ") : undefined;
}

/** The session a process is most plausibly running: pane-title name match, else most recently created before start. */
export function pickSessionInfo(sessions: SessionInfo[], startMs: number, paneName?: string): SessionInfo | undefined {
	if (sessions.length === 0) return undefined;
	if (paneName) {
		const named = sessions.find((session) => session.name === paneName);
		if (named) return named;
	}
	const prior = sessions.filter((session) => session.created.getTime() <= startMs + 2000);
	const pool = prior.length > 0 ? prior : sessions;
	return pool.reduce((a, b) => (b.created.getTime() > a.created.getTime() ? b : a));
}

/** Short label for a process group heading (basename, sorted last when unknown). */
export function workspaceTitle(workspace: string): string {
	return basename(workspace);
}

/** Group key sorts last so "unknown" processes don't displace real workspaces. */
export function workspaceSortKey(workspace: string): string {
	return workspace || "\uffff";
}

export function processLabelFallback(cwd: string | undefined, session: SessionInfo | undefined): string {
	const label = session?.name?.trim() || session?.firstMessage?.trim().replace(/\s+/g, " ") || (cwd ? basename(cwd) : "pi");
	return sanitize(label);
}
