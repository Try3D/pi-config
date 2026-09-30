/**
 * Sidebar: a docked info panel that reflows the transcript instead of covering it.
 *
 * Pi's regular TUI has no sidebar region, so in fullscreen mode this wraps the
 * renderer's layout root in an `HStack`:
 *
 *     HStack[ original VStack (transcript + dock) | Sidebar ]
 *
 * That gives a docked column: the transcript, editor, and footer shrink to
 * the remaining width and nothing is hidden. In regular mode there is no layout
 * engine, so it falls back to a non-capturing full-height overlay that does
 * cover content. Switch to fullscreen mode to avoid that.
 *
 * The layout root is a private field on the renderer (`layoutRoot`), read and
 * restored here. This is version-fragile, so if a future pi renames it, the
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
 * `title` extension, which names sessions with a small model) and fall back
 * to the session's first user message.
 *
 * Each process publishes its own status to `~/.pi/agent/sidebar/<pid>.json`
 * (label, cwd, model, branch, tmux pane). Every sidebar watches that directory,
 * so a change anywhere (a title, a model switch, a new pane) live-updates all
 * running sidebars; ps decides which pids exist.
 *
 * Module split: types.ts (constants + shared types), format.ts (pure
 * formatting/parsing), component.ts (the panel TUI component), footer.ts
 * (session-name-quiet footer), index.ts (lifecycle, discovery, commands).
 */

import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, StackEntry, TUI } from "@earendil-works/pi-tui";
import { HStack, isViewportTUI } from "@earendil-works/pi-tui";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, readlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	elapsedMs,
	piRoot,
	pickSessionInfo,
	processLabelFallback,
	sanitize,
	shortElapsed,
	titleSessionName,
} from "./format.ts";
import { QuietFooter } from "./footer.ts";
import { SidebarComponent } from "./component.ts";
import {
	MAX_PROCESSES,
	MIN_TERMINAL_WIDTH,
	PROCESS_REFRESH_MS,
	SHARED_DIR,
	WIDTH,
	type ProcessItem,
	type SharedStatus,
	type SidebarState,
	type Side,
	type TmuxTarget,
} from "./types.ts";

export default function (pi: ExtensionAPI) {
	const state: SidebarState = {
		model: "—",
		thinking: "—",
		cwd: "",
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

	const theme = (): Theme | undefined => (lastTheme = ctx?.ui.theme ?? lastTheme);
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
	 * - fullscreen: wrap or restore the layout root (true docked column)
	 * - regular: full-height non-capturing overlay
	 */
	const reconcile = () => {
		if (!tui) return;

		if (isViewportTUI(tui)) {
			if (overlay) {
				overlay.hide();
				overlay = undefined;
			}
			const viewport = tui as unknown as { layoutRoot?: Component };
			// The layout root is private API; if it is gone, fall back to the overlay
			// instead of silently rendering nothing.
			if (!("layoutRoot" in viewport)) {
				if (visible) showOverlay();
				return;
			}
			const current = viewport.layoutRoot;
			// Adopt the root once. If someone else replaced it, do not re-wrap their
			// wrapper (that nests HStacks forever); leave it alone.
			if (!originalRoot && current) originalRoot = current;
			if (current && current !== wrapped && current !== originalRoot) return;
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
		try {
			tui?.requestRender();
		} catch {
			// The renderer was replaced or is gone; re-grab it on next use.
			tui = undefined;
			originalRoot = undefined;
			wrapped = undefined;
			wrappedSide = undefined;
		}
		void publishSelf();
	};

	let timer: ReturnType<typeof setInterval> | undefined;
	/** Set by session_shutdown so in-flight async work cannot resurrect state. */
	let shuttingDown = false;

	const syncData = (source: ExtensionContext) => {
		const usage = source.getContextUsage();
		state.model = source.model?.id ?? "—";
		state.thinking = pi.getThinkingLevel();
		state.cwd = source.cwd;
		state.percent = usage?.percent ?? null;
		state.contextWindow = usage?.contextWindow;
	};

	const ownFile = join(SHARED_DIR, `${process.pid}.json`);
	let publishedSignature: string | undefined;
	let watcher: FSWatcher | undefined;
	let watchDebounce: ReturnType<typeof setTimeout> | undefined;

	/** Publish this process's own status; other sidebars watch the directory and merge it in. */
	const publishSelf = async (): Promise<void> => {
		if (shuttingDown) return;
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
			await mkdir(SHARED_DIR, { recursive: true, mode: 0o700 });
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
			await writeFile(ownFile, `${JSON.stringify(status)}\n`, { mode: 0o600 });
			publishedSignature = signature;
		} catch {
			/* best-effort */
		}
	};

	/** Every process's published status, including our own. */
	const readShared = async (): Promise<Map<number, SharedStatus>> => {
		const statuses = new Map<number, SharedStatus>();
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(SHARED_DIR, { withFileTypes: true });
		} catch {
			return statuses; // directory does not exist yet
		}
		for (const entry of entries) {
			// Regular files only: a planted symlink must not be followed.
			if (!entry.name.endsWith(".json") || !entry.isFile()) continue;
			let raw: unknown;
			try {
				raw = JSON.parse(await readFile(join(SHARED_DIR, entry.name), "utf8"));
			} catch {
				continue; // skip malformed
			}
			// Published by another process: validate instead of trusting the shape.
			const status = raw as Partial<SharedStatus>;
			if (typeof status?.pid !== "number" || !Number.isFinite(status.pid)) continue;
			const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
			statuses.set(status.pid, {
				pid: status.pid,
				label: str(status.label),
				cwd: str(status.cwd),
				model: str(status.model),
				thinking: str(status.thinking),
				branch: str(status.branch),
				pane: str(status.pane),
				updatedAt: typeof status.updatedAt === "number" ? status.updatedAt : 0,
			});
		}
		return statuses;
	};

	/** Any republish anywhere refreshes every sidebar. */
	const startWatching = async (): Promise<void> => {
		if (watcher) return;
		try {
			await mkdir(SHARED_DIR, { recursive: true, mode: 0o700 });
			watcher = watch(SHARED_DIR, { persistent: false }, () => {
				if (shuttingDown) return;
				if (watchDebounce) clearTimeout(watchDebounce);
				watchDebounce = setTimeout(() => void loadProcesses(), 150);
			});
			// A deleted/replaced directory emits 'error'; unhandled it would throw.
			watcher.on("error", () => {
				watcher?.close();
				watcher = undefined;
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
			return undefined; // transient read failure: do not cache the miss
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
			// `args` is last and may contain spaces, so parse the four fixed columns
			// with a regex instead of splitting on whitespace.
			output = (await pi.exec("ps", ["-eo", "pid=,ppid=,comm=,etime=,args="])).stdout;
		} catch {
			return [];
		}
		const parsed = output
			.split("\n")
			.map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line))
			.filter((match): match is RegExpExecArray => match !== null)
			.map((match) => ({
				pid: Number(match[1] ?? NaN),
				ppid: Number(match[2] ?? NaN),
				comm: match[3] ?? "",
				etime: match[4] ?? "",
				args: match[5] ?? "",
			}));
		const parents = new Map<number, number>();
		for (const row of parsed) if (Number.isFinite(row.pid) && Number.isFinite(row.ppid)) parents.set(row.pid, row.ppid);

		// `comm` is the basename on Linux but a (truncated) path on macOS, and a
		// node/bun install reports `node`/`bun`; accept both shapes.
		const rows = parsed.filter((row) => {
			const comm = basename(row.comm).replace(/\.exe$/, "");
			if (comm === "pi" || comm === "pi-coding-agent") return true;
			return /^(node|bun)$/.test(comm) && /(^|[\s/])pi(-coding-agent)?([\s/]|$)/.test(row.args);
		});

		// One lsof call for all found pids gives each process's cwd and any open
		// file under its pi install, from which we read the running version.
		const pids = rows.map((row) => row.pid).filter(Number.isFinite);
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
		for (const row of rows) {
			const { pid, etime } = row;
			if (!Number.isFinite(pid)) continue;
			const info = shared.get(pid);
			const cwd = cwds.get(pid) ?? info?.cwd ?? (await readlink(`/proc/${pid}/cwd`).catch(() => undefined));
			const root = roots.get(pid);
			const tmux = (info?.pane ? byPane.get(info.pane) : undefined) ?? panes.get(pid);
			const elapsed = elapsedMs(etime);
			// Without a parseable start time the session heuristic would guess wrong.
			const session = cwd && elapsed !== undefined ? pickSessionInfo(await sessionsFor(cwd), Date.now() - elapsed, tmux?.name) : undefined;
			// A publishing process is authoritative: no name means a brand-new
			// session, so don't inherit the heuristic's older session title.
			const label = info ? sanitize(info.label?.trim() || "(new session)") : processLabelFallback(cwd, session);
			items.push({
				pid,
				label,
				version: root ? await readVersion(root) : undefined,
				elapsed: shortElapsed(etime),
				current: pid === process.pid,
				cwd,
				tmux,
			});
		}
		// Stable, machine-wide order (ascending pid) so every window lists rows
		// identically and a click never hits a shifted row.
		items.sort((a, b) => a.pid - b.pid);
		const visible = items.slice(0, MAX_PROCESSES);
		// Never hide this process's own row behind a busier machine's others.
		if (!visible.some((item) => item.current)) {
			const self = items.find((item) => item.current);
			if (self) visible[visible.length - 1] = self;
		}

		// Drop status files for processes that are gone (and stale for a day), so
		// pid reuse cannot attach a dead session's identity to a new process.
		const livePids = new Set(items.map((item) => item.pid));
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		for (const [pid, status] of shared) {
			if (livePids.has(pid) || status.updatedAt > cutoff) continue;
			void unlink(join(SHARED_DIR, `${pid}.json`)).catch(() => undefined);
		}
		return visible;
	};

	let loading = false;
	let reloadPending = false;

	const loadProcesses = async () => {
		if (loading) {
			reloadPending = true;
			return;
		}
		loading = true;
		try {
			state.processes = await listProcesses();
			refresh();
		} catch {
			/* a failed poll must not break the panel or the process */
		} finally {
			loading = false;
			if (reloadPending && !shuttingDown) {
				reloadPending = false;
				void loadProcesses();
			}
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
		shuttingDown = false;
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
		// Renderer restarts can re-emit session_start; never leak an old interval.
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (visible) void loadProcesses();
		}, PROCESS_REFRESH_MS);
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		reloadPending = false;
		versionCache.clear();
		sessionCache.clear();
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
				const targets = state.processes.filter((item): item is ProcessItem & { tmux: TmuxTarget } => Boolean(item.tmux) && !item.current);
				await Promise.all(
					targets.map((item) =>
						pi.exec("tmux", ["send-keys", "-l", "-t", item.tmux.pane, "/reload"]).then(() =>
							pi.exec("tmux", ["send-keys", "-t", item.tmux.pane, "Enter"]).catch(() => undefined),
						).catch(() => undefined),
					),
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
