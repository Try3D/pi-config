/**
 * Sidebar — a docked info panel that reflows the transcript instead of covering it.
 *
 * Pi's regular TUI has no sidebar region, so in fullscreen mode this wraps the
 * renderer's layout root in an `HStack`:
 *
 *     HStack[ original VStack (transcript + dock) | Sidebar ]
 *
 * That gives a real docked column: the transcript, editor, and footer shrink to
 * the remaining width and nothing is hidden. In regular mode there is no layout
 * engine, so it falls back to a non-capturing full-height overlay (which does
 * cover content — switch to fullscreen mode to avoid that).
 *
 * The layout root is a private field on the renderer (`layoutRoot`), read and
 * restored here. This is version-fragile: if a future pi renames it, the
 * extension degrades to the overlay path.
 *
 * `/sidebar`            toggle visibility
 * `/sidebar left|right` move it
 * `/sidebar on|off`     explicit show/hide
 * `/sidebar reload`     send /reload to every pi pane in tmux
 * `ctrl+shift+s`        toggle visibility
 *
 * In fullscreen mode, clicking a process row switches tmux to that process's
 * pane (only when running inside tmux).
 *
 * Session labels come from the session's name when set (see the separate
 * `title.ts` extension, which names sessions with a small model) and fall back
 * to the session's first user message.
 *
 * Each process publishes its own status to `~/.pi/agent/sidebar/<pid>.json`
 * (label, cwd, model, branch, tmux pane). Every sidebar watches that directory,
 * so a change anywhere (a title, a model switch, a new pane) live-updates all
 * running sidebars; ps remains the source of truth for which pids exist.
 */

import {
	FooterComponent,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ReadonlyFooterDataProvider,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, StackEntry, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { HStack, isViewportTUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const SHARED_DIR = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? ".", ".pi", "agent"), "sidebar");
const WIDTH = 34;
const MIN_TERMINAL_WIDTH = 100;
const MAX_PROCESSES = 12;
const PROCESS_REFRESH_MS = 5000;

type Side = "left" | "right";

interface TmuxTarget {
	session: string;
	window: string;
	pane: string;
	name?: string;
}

interface ProcessItem {
	pid: number;
	label: string;
	version?: string;
	elapsed: string;
	current: boolean;
	cwd?: string;
	tmux?: TmuxTarget;
}

/** Per-process status published to disk so every sidebar sees every pi exactly as it sees itself. */
interface SharedStatus {
	pid: number;
	label?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	branch?: string;
	pane?: string;
	updatedAt: number;
}

interface SidebarState {
	model: string;
	thinking: string;
	cwd: string;
	branch?: string;
	tokens: number | null;
	contextWindow?: number;
	percent: number | null;
	turns: number;
	streaming: boolean;
	processes: ProcessItem[];
}

function homePath(cwd: string): string {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Compact an `etime` value ([[dd-]hh:]mm:ss) into `6d 19h`, `2h 29m`, or `5m`. */
function shortElapsed(etime: string): string {
	const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):\d+$/);
	if (!match) return etime;
	const [, days, hours, minutes] = match;
	if (days) return `${days}d ${hours ?? "0"}h`;
	if (hours) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

/** Parse a ps `etime` value into elapsed milliseconds. */
function elapsedMs(etime: string): number {
	const match = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
	if (!match) return 0;
	const [, days, hours, minutes, seconds] = match;
	return (((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

/** Session name embedded in the pi terminal title (`pi - name - cwd`). */
function titleSessionName(title: string): string | undefined {
	const parts = title.split(" - ");
	return parts.length >= 3 ? parts.slice(1, -1).join(" - ") : undefined;
}

/** The session a process is most plausibly running: pane-title name match, else most recently created before start. */
function pickSessionInfo(sessions: SessionInfo[], startMs: number, paneName?: string): SessionInfo | undefined {
	if (sessions.length === 0) return undefined;
	if (paneName) {
		const named = sessions.find((session) => session.name === paneName);
		if (named) return named;
	}
	const prior = sessions.filter((session) => session.created.getTime() <= startMs + 2000);
	const pool = prior.length > 0 ? prior : sessions;
	return pool.reduce((a, b) => (b.created.getTime() > a.created.getTime() ? b : a));
}

/** Extract the pi install root from an open path under the pi package. */
function piRoot(path: string): string | undefined {
	for (const marker of ["/@earendil-works/pi-coding-agent", "/@mariozechner/pi-coding-agent"]) {
		const index = path.indexOf(marker);
		if (index !== -1) return path.slice(0, index + marker.length);
	}
	return undefined;
}

function contextBar(theme: Theme, state: SidebarState, cellBudget: number): string {
	if (state.percent === null) return theme.fg("dim", "?");
	const cells = Math.max(4, Math.min(12, cellBudget));
	const filled = Math.round((state.percent / 100) * cells);
	const color = state.percent >= 85 ? "error" : state.percent >= 65 ? "warning" : "success";
	const window = state.contextWindow ? ` ${(state.contextWindow / 1000).toFixed(0)}k` : "";
	return theme.fg(color, "█".repeat(filled) + "░".repeat(cells - filled)) + theme.fg("dim", ` ${Math.round(state.percent)}%${window}`);
}

class SidebarComponent implements Component {
	private rowPids = new Map<number, number>();

	constructor(
		private readonly state: () => SidebarState,
		private readonly theme: () => Theme,
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
		const ordered = [...groups.entries()].sort(([a], [b]) => (a || "\uffff").localeCompare(b || "\uffff"));
		for (const [workspace, items] of ordered) {
			const title = workspace ? basename(workspace) : "unknown";
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

		return body;
	}

	invalidate(): void {}
}

/**
 * pi's stock footer with the `• <session name>` suffix suppressed: the session
 * title is redundant there because tmux already names the window from the
 * terminal title. Everything else (branch, token stats, context, model) is the
 * real built-in footer reading live state through the stub session.
 */
class QuietFooter extends FooterComponent {
	constructor(footerData: ReadonlyFooterDataProvider, stub: unknown) {
		super(stub as never, footerData);
	}

	/** Ignore pi swapping in the real session, which would re-add the name. */
	override setSession(): void {}
}

export default function (pi: ExtensionAPI) {
	const state: SidebarState = {
		model: "—",
		thinking: "—",
		cwd: "",
		tokens: null,
		percent: null,
		turns: 0,
		streaming: false,
		processes: [],
	};

	let ctx: ExtensionContext | undefined;
	let tui: TUI | undefined;
	let overlay: OverlayHandle | undefined;
	let overlaySide: Side | undefined;
	let originalRoot: Component | undefined;
	let wrapped: Component | undefined;
	let wrappedSide: Side | undefined;
	let lastTheme: Theme | undefined;
	let side: Side = "left";
	let visible = true;

	const theme = (): Theme => (lastTheme = ctx?.ui.theme ?? lastTheme!);
	const height = () => tui?.terminal.rows ?? process.stdout.rows ?? 24;

	/** Jump tmux to the pane running the given pi process. */
	const focusProcess = async (pid: number) => {
		const tmux = state.processes.find((item) => item.pid === pid)?.tmux;
		if (!tmux) return;
		await pi.exec("tmux", ["switch-client", "-t", tmux.session]).catch(() => undefined);
		await pi.exec("tmux", ["select-window", "-t", tmux.window]).catch(() => undefined);
		await pi.exec("tmux", ["select-pane", "-t", tmux.pane]).catch(() => undefined);
	};

	const makeSidebar = () => new SidebarComponent(() => state, theme, height, () => side, (pid) => void focusProcess(pid));

	const buildWrapped = (root: Component): Component => {
		const panel: StackEntry = {
			component: makeSidebar(),
			basis: WIDTH,
			minSize: WIDTH,
			maxSize: WIDTH,
			shrink: 0,
			visible: (viewport) => viewport.width >= MIN_TERMINAL_WIDTH,
		};
		const main: StackEntry = { component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 };
		return new HStack(side === "right" ? [main, panel] : [panel, main], { gap: 0 });
	};

	const overlayOptions = (): OverlayOptions => ({
		anchor: side === "right" ? "top-right" : "top-left",
		width: WIDTH,
		maxHeight: "100%",
		margin: { top: 0, bottom: 0, right: side === "right" ? 1 : 0, left: side === "left" ? 1 : 0 },
		nonCapturing: true,
		visible: (termWidth) => termWidth >= MIN_TERMINAL_WIDTH,
	});

	const showOverlay = () => {
		if (!tui || overlay) return;
		overlay = tui.showOverlay(makeSidebar(), overlayOptions());
		overlaySide = side;
	};

	/**
	 * Reconcile the sidebar with the current renderer:
	 * - fullscreen -> wrap/restore the layout root (true docked column)
	 * - regular    -> full-height non-capturing overlay
	 */
	const reconcile = () => {
		if (!tui) return;

		if (isViewportTUI(tui)) {
			if (overlay) {
				overlay.hide();
				overlay = undefined;
			}
			const current = (tui as unknown as { layoutRoot?: Component }).layoutRoot;
			if (current && current !== wrapped && current !== originalRoot) {
				// New renderer, or someone else replaced the root: adopt it.
				originalRoot = current;
				wrapped = undefined;
			}
			if (!originalRoot) return;
			if (!wrapped || wrappedSide !== side) {
				wrapped = buildWrapped(originalRoot);
				wrappedSide = side;
			}
			tui.setLayoutRoot(visible ? wrapped : originalRoot);
			return;
		}

		// Regular mode has no layout engine, so fall back to an overlay.
		wrapped = undefined;
		originalRoot = undefined;
		wrappedSide = undefined;
		if (overlay && overlaySide !== side) {
			overlay.hide();
			overlay = undefined;
		}
		if (!overlay && visible) showOverlay();
		else if (overlay) overlay.setHidden(!visible);
	};

	const refresh = () => {
		reconcile();
		tui?.requestRender();
		void publishSelf();
	};

	let timer: ReturnType<typeof setInterval> | undefined;

	const syncData = (source: ExtensionContext) => {
		const usage = source.getContextUsage();
		state.model = source.model?.id ?? "—";
		state.thinking = pi.getThinkingLevel();
		state.cwd = source.cwd;
		state.tokens = usage?.tokens ?? null;
		state.percent = usage?.percent ?? null;
		state.contextWindow = usage?.contextWindow;
	};

	const ownFile = join(SHARED_DIR, `${process.pid}.json`);
	let publishedSignature: string | undefined;
	let watcher: FSWatcher | undefined;
	let watchDebounce: ReturnType<typeof setTimeout> | undefined;

	/** Publish this process's own status; other sidebars watch the directory and merge it in. */
	const publishSelf = async (): Promise<void> => {
		const signature = [
			state.cwd,
			pi.getSessionName() ?? "",
			state.model,
			state.thinking,
			state.branch ?? "",
			process.env.TMUX_PANE ?? "",
		].join("\u0000");
		if (signature === publishedSignature) return;
		try {
			await mkdir(SHARED_DIR, { recursive: true });
			const status: SharedStatus = {
				pid: process.pid,
				label: pi.getSessionName(),
				cwd: state.cwd,
				model: state.model,
				thinking: state.thinking,
				branch: state.branch,
				pane: process.env.TMUX_PANE,
				updatedAt: Date.now(),
			};
			await writeFile(ownFile, `${JSON.stringify(status)}\n`);
			publishedSignature = signature;
		} catch {
			/* best-effort */
		}
	};

	/** Every process's published status, including our own. */
	const readShared = async (): Promise<Map<number, SharedStatus>> => {
		const statuses = new Map<number, SharedStatus>();
		try {
			for (const name of await readdir(SHARED_DIR)) {
				if (!name.endsWith(".json")) continue;
				try {
					const status = JSON.parse(await readFile(join(SHARED_DIR, name), "utf8")) as SharedStatus;
					if (Number.isFinite(status.pid)) statuses.set(status.pid, status);
				} catch {
					/* skip malformed */
				}
			}
		} catch {
			/* directory does not exist yet */
		}
		return statuses;
	};

	/** Any republish anywhere refreshes every sidebar. */
	const startWatching = async (): Promise<void> => {
		if (watcher) return;
		try {
			await mkdir(SHARED_DIR, { recursive: true });
			watcher = watch(SHARED_DIR, { persistent: false }, () => {
				if (watchDebounce) clearTimeout(watchDebounce);
				watchDebounce = setTimeout(() => void loadProcesses(), 150);
			});
		} catch {
			/* watching is optional */
		}
	};

	const versionCache = new Map<string, string | undefined>();
	const readVersion = async (root: string): Promise<string | undefined> => {
		if (versionCache.has(root)) return versionCache.get(root);
		let version: string | undefined;
		try {
			version = (JSON.parse(await readFile(`${root}/package.json`, "utf8")) as { version?: string }).version;
		} catch {
			/* unreadable install */
		}
		versionCache.set(root, version);
		return version;
	};

	/** tmux targets keyed by pi pid (ancestry walk) and by pane id (for self-published panes). */
	const tmuxTargets = async (
		pids: number[],
		parents: Map<number, number>,
	): Promise<{ byPid: Map<number, TmuxTarget>; byPane: Map<string, TmuxTarget> }> => {
		const byPid = new Map<number, TmuxTarget>();
		const byPane = new Map<string, TmuxTarget>();
		if (pids.length === 0 || !process.env.TMUX) return { byPid, byPane };
		let output: string;
		try {
			output = (await pi.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{session_id}\t#{window_id}\t#{pane_title}"])).stdout;
		} catch {
			return { byPid, byPane };
		}
		const paneByPid = new Map<number, TmuxTarget>();
		for (const line of output.split("\n")) {
			const [pane, pidText, session, window, title] = line.split("\t");
			const panePid = Number(pidText);
			if (pane && session && window && Number.isFinite(panePid)) {
				const target = { session, window, pane, name: title ? titleSessionName(title) : undefined };
				paneByPid.set(panePid, target);
				byPane.set(pane, target);
			}
		}
		for (const pid of pids) {
			const seen = new Set<number>();
			let cursor: number | undefined = pid;
			while (cursor !== undefined && cursor > 1 && !seen.has(cursor)) {
				seen.add(cursor);
				const target = paneByPid.get(cursor);
				if (target) {
					byPid.set(pid, target);
					break;
				}
				cursor = parents.get(cursor);
			}
		}
		return { byPid, byPane };
	};

	/** Session metadata per cwd, cached briefly since listing reads every session file. */
	const sessionCache = new Map<string, { at: number; list: SessionInfo[] }>();
	const sessionsFor = async (cwd: string): Promise<SessionInfo[]> => {
		const cached = sessionCache.get(cwd);
		const now = Date.now();
		if (cached && now - cached.at < 30_000) return cached.list;
		try {
			const list = await SessionManager.list(cwd);
			sessionCache.set(cwd, { at: now, list });
			return list;
		} catch {
			return cached?.list ?? [];
		}
	};

	/** List every running pi process on the machine (pid, cwd, version, uptime). */
	const listProcesses = async (): Promise<ProcessItem[]> => {
		let output: string;
		try {
			output = (await pi.exec("ps", ["-eo", "pid=,ppid=,comm=,etime="])).stdout;
		} catch {
			return [];
		}
		const all = output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => line.split(/\s+/));
		const parents = new Map<number, number>();
		for (const parts of all) {
			const pid = Number(parts[0]);
			const ppid = Number(parts[1]);
			if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
		}
		const rows = all.filter((parts) => parts[2] === "pi");

		// One lsof call for all found pids gives each process's cwd and any open
		// file under its pi install, from which we read the running version.
		const pids = rows.map((parts) => Number(parts[0])).filter(Number.isFinite);
		const cwds = new Map<number, string>();
		const roots = new Map<number, string>();
		if (pids.length > 0) {
			try {
				const lsof = await pi.exec("lsof", ["-a", "-p", pids.join(","), "-Fn"]);
				let pid: number | undefined;
				let fd = "";
				for (const line of lsof.stdout.split("\n")) {
					if (line.startsWith("p")) pid = Number(line.slice(1));
					else if (line.startsWith("f")) fd = line.slice(1);
					else if (line.startsWith("n") && pid !== undefined) {
						const path = line.slice(1);
						if (fd === "cwd") cwds.set(pid, path);
						else if (!roots.has(pid)) {
							const root = piRoot(path);
							if (root) roots.set(pid, root);
						}
					}
				}
			} catch {
				/* lsof is optional */
			}
		}

		const { byPid: panes, byPane } = await tmuxTargets(pids, parents);
		const shared = await readShared();

		const items: ProcessItem[] = [];
		for (const parts of rows) {
			const pid = Number(parts[0]);
			if (!Number.isFinite(pid)) continue;
			const info = shared.get(pid);
			const cwd = cwds.get(pid) ?? info?.cwd ?? (await readlink(`/proc/${pid}/cwd`).catch(() => undefined));
			const root = roots.get(pid);
			const tmux = (info?.pane ? byPane.get(info.pane) : undefined) ?? panes.get(pid);
			const startMs = Date.now() - elapsedMs(parts[3] ?? "");
			const session = cwd ? pickSessionInfo(await sessionsFor(cwd), startMs, tmux?.name) : undefined;
			// A publishing process is authoritative: no name means a brand-new
			// session, so don't inherit the heuristic's older session title.
			const label = info
				? info.label?.trim() || "(new session)"
				: session?.name?.trim() || session?.firstMessage?.trim().replace(/\s+/g, " ") || (cwd ? basename(cwd) : "pi");
			items.push({
				pid,
				label,
				version: root ? await readVersion(root) : undefined,
				elapsed: shortElapsed(parts[3] ?? ""),
				current: pid === process.pid,
				cwd,
				tmux,
			});
		}
		// Stable, machine-wide order (ascending pid) so every window lists rows
		// identically and a click never lands on a shifted row.
		items.sort((a, b) => a.pid - b.pid);
		return items.slice(0, MAX_PROCESSES);
	};

	let loading = false;

	const loadProcesses = async () => {
		if (loading) return;
		loading = true;
		try {
			state.processes = await listProcesses();
			refresh();
		} finally {
			loading = false;
		}
	};

	/** Grab a TUI reference once by opening a no-op custom overlay and closing it immediately. */
	const ensureTui = async (source: ExtensionContext) => {
		if (source.mode !== "tui" || tui) return;
		lastTheme = source.ui.theme;
		await source.ui.custom<void>((instance, _theme, _keybindings, done) => {
			tui = instance;
			done(undefined);
			return { render: () => [], invalidate: () => {} };
		});
	};

	/** Replace the built-in footer with one that omits the session name. */
	const installFooter = (source: ExtensionContext): void => {
		if (source.mode !== "tui" || !source.ui.setFooter) return;
		const stub = {
			get state() {
				return { model: ctx?.model, thinkingLevel: pi.getThinkingLevel() };
			},
			get sessionManager() {
				return {
					getEntries: () => ctx?.sessionManager?.getEntries() ?? [],
					getCwd: () => ctx?.cwd ?? process.cwd(),
					getSessionName: () => undefined,
				};
			},
			getContextUsage: () => ctx?.getContextUsage(),
			modelRuntime: { isUsingSubscription: () => false },
		};
		try {
			source.ui.setFooter((_tui, _theme, footerData) => new QuietFooter(footerData, stub));
		} catch {
			/* fall back to the built-in footer */
		}
	};

	pi.on("session_start", async (_event, source) => {
		ctx = source;
		if (source.mode !== "tui") return;
		syncData(source);
		state.turns = 0;

		const branch = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: source.cwd }).catch(() => undefined);
		const name = branch?.stdout.trim();
		state.branch = name && name !== "HEAD" ? name : undefined;

		await ensureTui(source);
		installFooter(source);
		await startWatching();
		refresh();
		void publishSelf();
		void loadProcesses();
		timer = setInterval(() => {
			if (visible) void loadProcesses();
		}, PROCESS_REFRESH_MS);
	});

	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		watcher?.close();
		watcher = undefined;
		if (watchDebounce) {
			clearTimeout(watchDebounce);
			watchDebounce = undefined;
		}
		void unlink(ownFile).catch(() => undefined);
		try {
			ctx?.ui.setFooter?.(undefined);
		} catch {
			/* renderer already gone */
		}
		if (tui && originalRoot && isViewportTUI(tui)) {
			try {
				tui.setLayoutRoot(originalRoot);
			} catch {
				/* renderer already gone */
			}
		}
		overlay?.hide();
		overlay = undefined;
		overlaySide = undefined;
		originalRoot = undefined;
		wrapped = undefined;
		wrappedSide = undefined;
		tui = undefined;
		ctx = undefined;
	});

	pi.on("model_select", (_event, source) => {
		syncData(source);
		refresh();
	});

	pi.on("thinking_level_select", (_event, source) => {
		syncData(source);
		refresh();
	});

	pi.on("session_info_changed", () => {
		refresh();
		void loadProcesses();
	});

	pi.on("agent_start", () => {
		state.streaming = true;
		refresh();
	});

	pi.on("agent_settled", (_event, source) => {
		state.streaming = false;
		syncData(source);
		refresh();
	});

	pi.on("turn_start", () => {
		state.turns++;
		refresh();
	});

	pi.registerCommand("sidebar", {
		description: "Toggle the info sidebar; /sidebar left|right, on|off, reload",
		handler: async (args, source) => {
			if (source.mode !== "tui") {
				source.ui.notify("Sidebar is only available in the TUI", "error");
				return;
			}
			ctx = source;
			await ensureTui(source);

			const arg = args.trim().toLowerCase();
			if (arg === "reload") {
				const targets = state.processes.filter((item) => item.tmux && !item.current);
				await Promise.all(
					targets.map((item) => pi.exec("tmux", ["send-keys", "-t", item.tmux!.pane, "/reload", "Enter"]).catch(() => undefined)),
				);
				source.ui.notify(`Sent /reload to ${targets.length} pi pane${targets.length === 1 ? "" : "s"}`, "info");
				return;
			}
			if (arg === "left" || arg === "right") {
				side = arg;
				visible = true;
			} else if (arg === "on" || arg === "off") {
				visible = arg === "on";
			} else {
				visible = !visible;
			}
			refresh();
			void loadProcesses();
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Toggle the info sidebar",
		handler: async (source) => {
			if (source.mode !== "tui") return;
			ctx = source;
			await ensureTui(source);
			visible = !visible;
			refresh();
		},
	});
}
