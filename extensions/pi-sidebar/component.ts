/**
 * The sidebar panel component: the process list grouped by workspace
 * (clickable when inside tmux). Render width is the docked column width; the
 * border column faces the transcript.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { workspaceSortKey, workspaceTitle } from "./format.ts";
import { INACTIVE_MARKER, SPINNER_FRAMES, type ProcessItem, type SidebarState, type Side } from "./types.ts";

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
		// Group by workspace; stable order (workspace, then pid) across windows.
		const groups = new Map<string, ProcessItem[]>();
		for (const item of state.processes) {
			const bucket = groups.get(item.cwd ?? "");
			if (bucket) bucket.push(item);
			else groups.set(item.cwd ?? "", [item]);
		}
		const ordered = [...groups.entries()].sort(([a], [b]) => workspaceSortKey(a).localeCompare(workspaceSortKey(b)));
		ordered.forEach(([workspace, items], index) => {
			if (index > 0) body.push(empty());
			const title = workspace ? workspaceTitle(workspace) : "unknown";
			body.push(row(" " + theme.fg("muted", `${title} (${items.length})`)));
			for (const item of items) {
				const spinner = SPINNER_FRAMES[state.frame % SPINNER_FRAMES.length] ?? "\uee06";
				// Glyph shows the only two states: loading (spinner) or idle (icon).
				// Accent is reserved for the active session; other panes use the default
				// foreground while loading and dim when idle.
				const glyph = item.streaming ? spinner : INACTIVE_MARKER;
				const tone = item.current ? "accent" : item.streaming ? "text" : "dim";
				const marker = theme.fg(tone, glyph);
				const limited = truncateToWidth(item.label, this.labelWidth(), "…");
				const name = item.current ? theme.fg("accent", limited) : theme.fg("text", limited);
				this.rowPids.set(body.length, item.pid);
				body.push(row(" " + marker + " " + name + " " + theme.fg("dim", item.elapsed)));
			}
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
