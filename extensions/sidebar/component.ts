/**
 * The sidebar panel component: model/thinking/dir/branch header, process list
 * grouped by workspace (clickable when inside tmux), context bar, and footer
 * status rows. Render width is the docked column width; the border column
 * faces the transcript.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homePath, workspaceSortKey, workspaceTitle } from "./format.ts";
import type { ProcessItem, SidebarState, Side } from "./types.ts";

function contextBar(theme: Theme, state: SidebarState, cellBudget: number): string {
	if (state.percent === null) return theme.fg("dim", "?");
	const cells = Math.max(4, Math.min(12, cellBudget));
	const percent = Math.max(0, Math.min(100, state.percent));
	const filled = Math.min(cells, Math.round((percent / 100) * cells));
	const color = percent >= 85 ? "error" : percent >= 65 ? "warning" : "success";
	const window = state.contextWindow ? ` ${(state.contextWindow / 1000).toFixed(0)}k` : "";
	return theme.fg(color, "█".repeat(filled) + "░".repeat(cells - filled)) + theme.fg("dim", ` ${Math.round(percent)}%${window}`);
}

export class SidebarComponent implements Component {
	private rowPids = new Map<number, number>();

	constructor(
		private readonly state: () => SidebarState,
		private readonly theme: () => Theme | undefined,
		private readonly height: () => number,
		private readonly side: () => Side,
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
		const label = (text: string) => theme.fg("muted", text.padEnd(9));
		const value = (text: string) => theme.fg("text", text);
		const empty = () => row("");

		const upper = [
			row(" " + label("Model") + value(state.model)),
			row(" " + label("Thinking") + value(state.thinking)),
			empty(),
			row(" " + label("Dir") + value(homePath(state.cwd))),
			row(" " + label("Branch") + value(state.branch ?? "—")),
			empty(),
		];
		this.rowPids = new Map();
		if (state.processes.length === 0) {
			upper.push(row(" " + theme.fg("dim", "(no pi processes)")));
		}
		// Group by workspace; stable order (workspace, then pid) across windows.
		const groups = new Map<string, ProcessItem[]>();
		for (const item of state.processes) {
			const bucket = groups.get(item.cwd ?? "");
			if (bucket) bucket.push(item);
			else groups.set(item.cwd ?? "", [item]);
		}
		const ordered = [...groups.entries()].sort(([a], [b]) => workspaceSortKey(a).localeCompare(workspaceSortKey(b)));
		for (const [workspace, items] of ordered) {
			const title = workspace ? workspaceTitle(workspace) : "unknown";
			upper.push(row(" " + theme.fg("muted", `${title} (${items.length})`)));
			for (const item of items) {
				const marker = item.current ? theme.fg("accent", "▸") : theme.fg("dim", "·");
				const name = item.current ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				const meta = [item.version && `v${item.version}`, item.elapsed].filter((part): part is string => Boolean(part)).join(" · ");
				this.rowPids.set(upper.length, item.pid);
				upper.push(row(" " + marker + " " + name + " " + theme.fg("dim", meta)));
			}
			upper.push(empty());
		}
		upper.push(
			empty(),
			row(" " + label("Context") + contextBar(theme, state, inner - 10)),
			row(" " + label("Turns") + value(String(state.turns))),
		);

		const jumpHint = state.processes.some((item) => item.tmux);
		const footer = [
			empty(),
			row(" " + (state.streaming ? theme.fg("accent", "▶ working…") : theme.fg("dim", "idle"))),
			row(" " + theme.fg("dim", jumpHint ? "click a process to jump" : "ctrl+shift+s to hide")),
		];

		const filler = Math.max(0, total - upper.length - footer.length);
		const body =
			filler > 0 ? [...upper, ...Array.from({ length: filler }, empty), ...footer] : [...upper, ...footer].slice(0, total);

		// Rows sliced away are not rendered, so they must not stay clickable.
		for (const y of this.rowPids.keys()) if (y >= body.length) this.rowPids.delete(y);

		return body;
	}

	invalidate(): void {}
}
