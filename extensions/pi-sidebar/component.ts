/**
 * The sidebar panel component: one machine-wide process tree (root sessions
 * grouped by workspace, subagents nested under their spawner) plus a right-aligned
 * `go up` button on the current session's heading for subagent panes. Every pane
 * renders the same tree; only the current node's highlight differs. Rows are
 * clickable when inside tmux. Render width is the docked column width; the border
 * column faces the transcript.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitize, workspaceSortKey, workspaceTitle } from "./format.ts";
import { DONE_MARKER, GO_UP_MARKER, INACTIVE_MARKER, SPINNER_FRAMES, SUBAGENT_MARKER, type ProcessItem, type SidebarState, type Side } from "./types.ts";

export class SidebarComponent implements Component {
	private rowPids = new Map<number, number>();

	constructor(
		private readonly state: () => SidebarState,
		private readonly theme: () => Theme | undefined,
		private readonly height: () => number,
		private readonly side: () => Side,
		private readonly labelWidth: () => number,
		private readonly onSelect?: (pid: number) => void,
	) {}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const pid = this.rowPids.get(event.y);
		if (event.button !== "left" || pid === undefined) return undefined;
		if (!this.state().processes.find((item) => item.pid === pid)?.tmux) return undefined;
		if (event.type === "press") return { handled: true };
		if (event.type === "click") {
			this.onSelect?.(pid);
			return { handled: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		if (width < 2) return [];
		const theme = this.theme();
		if (!theme) return [];
		const state = this.state();
		const inner = Math.max(0, width - 1);
		const total = Math.max(1, this.height());

		const pad = (line: string) => line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
		const row = (line: string) => {
			// Reserve one column so a truncation ellipsis never touches the border.
			const content = pad(truncateToWidth(line, Math.max(0, inner - 1), "…"));
			// Border faces the transcript: left edge when docked right, right edge when docked left.
			return this.side() === "left" ? content + theme.fg("border", "│") : theme.fg("border", "│") + content;
		};
		const empty = () => row("");

		const body: string[] = [empty()];
		this.rowPids = new Map();
		if (state.processes.length === 0) {
			body.push(row(" " + theme.fg("dim", "(no pi processes)")));
		}

		// One machine-wide tree appears in every pane. It groups root sessions by
		// workspace and nests subagents under the process that spawned them. Only the
		// current node's highlight differs. `parentPid` links come from shared status files.
		const byPid = new Map(state.processes.map((item) => [item.pid, item]));
		const children = new Map<number, ProcessItem[]>();
		const roots: ProcessItem[] = [];
		for (const item of state.processes) {
			const parentPid = item.parentPid;
			// A link to self or an unknown pid cannot form a tree; treat it as a root.
			if (parentPid !== undefined && parentPid !== item.pid && byPid.has(parentPid)) {
				const bucket = children.get(parentPid);
				if (bucket) bucket.push(item);
				else children.set(parentPid, [item]);
			} else {
				roots.push(item);
			}
		}
		for (const list of children.values()) list.sort((a, b) => a.pid - b.pid);

		// Break stale or forged `parentPid` cycles. Promote sessions not reachable
		// from a root so each session appears in the tree once.
		const reachable = new Set<number>();
		const visit = (items: ProcessItem[]) => {
			for (const item of items) {
				if (reachable.has(item.pid)) continue;
				reachable.add(item.pid);
				visit(children.get(item.pid) ?? []);
			}
		};
		visit(roots);
		for (const item of state.processes) {
			if (reachable.has(item.pid)) continue;
			roots.push(item);
			visit([item]);
		}

		const groups = new Map<string, ProcessItem[]>();
		for (const root of roots) {
			const bucket = groups.get(root.cwd ?? "");
			if (bucket) bucket.push(root);
			else groups.set(root.cwd ?? "", [root]);
		}
		const ordered = [...groups.entries()].sort(([a], [b]) => workspaceSortKey(a).localeCompare(workspaceSortKey(b)));

		// "Go up": the current session's parent, and the workspace heading of the
		// group that contains the current session (where the button is placed). The
		// walk is cycle-guarded: `parentPid` comes from other processes' files.
		const self = state.processes.find((item) => item.current);
		const parent = self && self.parentPid !== undefined ? byPid.get(self.parentPid) : undefined;
		let selfRoot = self;
		const selfSeen = new Set<number>();
		while (selfRoot?.parentPid !== undefined && !selfSeen.has(selfRoot.pid)) {
			selfSeen.add(selfRoot.pid);
			selfRoot = byPid.get(selfRoot.parentPid);
		}
		const selfWorkspace = selfRoot?.cwd ?? "";

		// Count each node once (even across a broken cycle) for the heading total.
		const counted = new Set<number>();
		const subtreeSize = (item: ProcessItem): number => {
			if (counted.has(item.pid)) return 0;
			counted.add(item.pid);
			let size = 1;
			for (const child of children.get(item.pid) ?? []) size += subtreeSize(child);
			return size;
		};

		const spinner = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length] ?? "\uee06";
		const rendered = new Set<number>();
		const renderNode = (item: ProcessItem, prefix: string, isLast: boolean, depth: number) => {
			if (rendered.has(item.pid)) return;
			rendered.add(item.pid);
			const connector = depth === 0 ? "" : isLast ? "└─" : "├─";
			const tree = prefix + (connector ? `${connector} ` : "");
			// Subagent tabs are named `_N`; show the tab id so rows match the tab bar.
			const tab = item.tmux?.windowName && /^_\d+$/.test(item.tmux.windowName) ? `${item.tmux.windowName} ` : "";
			const head = " " + tree;
			const glyph = item.streaming ? spinner : depth === 0 ? INACTIVE_MARKER : SUBAGENT_MARKER;
			const tone = item.current ? "accent" : item.streaming ? "text" : "dim";
			const glyphText = theme.fg(tone, glyph);
			let tabText = tab ? theme.fg("dim", tab) : "";
			const elapsedText = theme.fg("dim", item.elapsed);
			// Appended once the process's last action finished; cleared when it runs again
			// and never shown on the current row, since you are already looking at it.
			let doneText = item.done && !item.current ? theme.fg("success", DONE_MARKER) : "";
			// Reserve everything but the label so the elapsed time is never clipped. When
			// even the label cannot fit, drop the optional columns instead of clipping it.
			let overhead = visibleWidth(head) + visibleWidth(glyphText) + 1 + visibleWidth(tabText) + 1 + visibleWidth(elapsedText) + (doneText ? visibleWidth(doneText) + 1 : 0);
			if (overhead >= inner - 1) {
				tabText = "";
				doneText = "";
				overhead = visibleWidth(head) + visibleWidth(glyphText) + 1 + 1 + visibleWidth(elapsedText);
			}
			const available = Math.max(0, Math.min(this.labelWidth(), inner - 1 - overhead));
			const limited = truncateToWidth(item.label, available, "…");
			const name = item.current ? theme.fg("accent", limited) : theme.fg("text", limited);
			this.rowPids.set(body.length, item.pid);
			body.push(row(head + glyphText + " " + tabText + name + " " + elapsedText + (doneText ? " " + doneText : "")));

			const kids = children.get(item.pid) ?? [];
			const childPrefix = prefix + (depth === 0 ? "" : isLast ? "   " : "│  ");
			kids.forEach((child, index) => renderNode(child, childPrefix, index === kids.length - 1, depth + 1));
		};

		ordered.forEach(([workspace, items], index) => {
			if (index > 0) body.push(empty());
			const title = workspace ? sanitize(workspaceTitle(workspace)) : "unknown";
			const size = items.reduce((sum, root) => sum + subtreeSize(root), 0);
			const heading = " " + theme.fg("muted", `${title} (${size})`);
			const button = `go up ${GO_UP_MARKER}`;
			const buttonFits = parent !== undefined && workspace === selfWorkspace && visibleWidth(heading) + visibleWidth(button) < inner - 1;
			if (buttonFits && parent) {
				// Right-aligned "go up" on the current session's heading.
				const gap = Math.max(1, inner - 1 - visibleWidth(heading) - visibleWidth(button));
				this.rowPids.set(body.length, parent.pid);
				body.push(row(heading + " ".repeat(gap) + theme.fg("muted", button)));
			} else {
				body.push(row(heading));
			}
			items.forEach((root, rootIndex) => renderNode(root, "", rootIndex === items.length - 1, 0));
		});

		// Pad to the panel height; rows beyond it are clipped.
		const filler = Math.max(0, total - body.length);
		const lines = filler > 0 ? [...body, ...Array.from({ length: filler }, empty)] : body.slice(0, total);

		// Rows sliced away are not rendered, so they must not stay clickable.
		for (const y of this.rowPids.keys()) if (y >= lines.length) this.rowPids.delete(y);

		return lines;
	}

	invalidate(): void {}
}
