/**
 * Simple /wait extension.
 *
 * /wait <duration> [prompt]   queue a prompt after a delay
 * /wait now                   send the queued prompt immediately
 * /wait pause                 pause the countdown
 * /wait resume                resume the countdown
 * /wait cancel                drop the queued prompt
 * /wait status                show queued prompt and time left
 *
 * Durations: 5, 5s, 5m, 1h, 500ms. Default unit is seconds.
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const WAIT_STATE_ENTRY = "pi-wait-state-v1";
const MAX_WAIT_MS = 24 * 60 * 60 * 1000; // 24h

type PendingWait =
	| { prompt: string; dueAt: number }
	| { prompt: string; delay: number }
	| { prompt: string; remaining: number; paused: true };

type WaitState = { version: 1; pending: PendingWait | null };

type WidgetTheme = Pick<Theme, "fg" | "bold">;

function parseDuration(input: string): number {
	const trimmed = input.trim();
	const match = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h)?$/.exec(trimmed);
	if (!match) throw new Error(`invalid duration: ${trimmed} (use e.g. 5s, 5m, 1h, 500ms)`);

	const value = Number(match[1]);
	const unit = match[2] ?? "s";
	const multipliers: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
	const ms = Math.round(value * (multipliers[unit] ?? 1000));

	if (!Number.isSafeInteger(ms) || ms < 1) throw new Error("duration must be at least 1ms");
	if (ms > MAX_WAIT_MS) throw new Error("duration must not exceed 24h");
	return ms;
}

function formatRemaining(ms: number): string {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

function formatWidget(wait: PendingWait, width: number, now: number, theme: WidgetTheme): string {
	const prompt = wait.prompt.replace(/\s+/g, " ").trim();
	const [icon, state, hints] =
		"paused" in wait
			? [theme.fg("muted", "⏸"), `paused ${formatRemaining(wait.remaining)}`, "/wait resume · /wait cancel"]
			: "dueAt" in wait
				? [theme.fg("warning", "◷"), formatRemaining(wait.dueAt - now), "/wait pause · /wait cancel"]
				: [theme.fg("muted", "◌"), "queued", "/wait cancel"];
	const sep = theme.fg("dim", " · ");
	return truncateToWidth(
		`${icon} ${theme.fg("accent", theme.bold("WAIT"))} ${theme.fg("muted", state)}${sep}${theme.fg("text", prompt)}${sep}${theme.fg("dim", hints)}`,
		width,
		"…",
	);
}

function isPendingWait(value: unknown): value is PendingWait {
	if (!value || typeof value !== "object") return false;
	const wait = value as Record<string, unknown>;
	if (typeof wait.prompt !== "string") return false;
	if (wait.paused === true) return Number.isFinite(wait.remaining);
	if ("dueAt" in wait) return Number.isFinite(wait.dueAt);
	if ("delay" in wait) return Number.isFinite(wait.delay);
	return false;
}

function readWaitState(entries: readonly SessionEntry[]): WaitState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== WAIT_STATE_ENTRY) continue;
		const data = entry.data;
		if (!data || typeof data !== "object" || !("version" in data) || data.version !== 1) continue;
		const statePending = "pending" in data ? data.pending : undefined;
		if (statePending === null) return { version: 1, pending: null };
		if (isPendingWait(statePending)) return { version: 1, pending: statePending };
		return undefined;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let pending: PendingWait | undefined;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;
	let sessionContext: ExtensionContext | undefined;
	let widgetVisible = false;
	let requestWidgetRender: (() => void) | undefined;

	function clearTimers(): void {
		if (deliveryTimer) clearTimeout(deliveryTimer);
		if (countdownTimer) clearInterval(countdownTimer);
		deliveryTimer = undefined;
		countdownTimer = undefined;
	}

	function notify(ctx: ExtensionContext, message: string, level: "info" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	function clearWidget(ctx = sessionContext): void {
		if (!ctx?.hasUI || !widgetVisible) return;
		widgetVisible = false;
		requestWidgetRender = undefined;
		ctx.ui.setWidget("pi-wait", undefined);
	}

	function renderWidget(ctx = sessionContext): void {
		if (!ctx?.hasUI || !pending) {
			clearWidget(ctx);
			return;
		}
		if (widgetVisible) {
			requestWidgetRender?.();
			return;
		}
		ctx.ui.setWidget("pi-wait", (tui, theme) => {
			requestWidgetRender = () => tui.requestRender();
			return {
				render: (width) => (pending ? [formatWidget(pending, width, Date.now(), theme)] : []),
				invalidate: () => {},
				dispose: () => {
					requestWidgetRender = undefined;
				},
			};
		});
		widgetVisible = true;
	}

	function persist(wait: PendingWait | undefined): void {
		pi.appendEntry(WAIT_STATE_ENTRY, { version: 1, pending: wait ?? null } satisfies WaitState);
	}

	function clearPending(): void {
		pending = undefined;
		persist(undefined);
	}

	function sendFailed(ctx: ExtensionContext, error: unknown): void {
		notify(ctx, `could not send queued message: ${error instanceof Error ? error.message : String(error)}`, "error");
	}

	function deliver(ctx: ExtensionContext, expected: PendingWait): void {
		if (pending !== expected) return;
		const prompt = expected.prompt;
		clearTimers();
		clearWidget(ctx);
		const options = ctx.isIdle()
			? { expandPromptTemplates: true }
			: { deliverAs: "followUp" as const, expandPromptTemplates: true };
		try {
			// ExtensionAPI types sendUserMessage as returning void. If the runtime
			// ever returns a Promise, wait for it before clearing state so an async
			// failure does not lose the queued prompt.
			const maybePromise = pi.sendUserMessage(prompt, options) as unknown as Promise<void> | undefined;
			if (maybePromise && typeof maybePromise.then === "function") {
				maybePromise
					.then(() => {
						if (pending === expected) clearPending();
					})
					.catch((error) => sendFailed(ctx, error));
				return;
			}
			clearPending();
		} catch (error) {
			sendFailed(ctx, error);
		}
	}

	function arm(ctx: ExtensionContext, wait: PendingWait, delay: number): void {
		clearTimers();
		const armed: PendingWait = { prompt: wait.prompt, dueAt: Date.now() + delay };
		pending = armed;
		persist(armed);
		deliveryTimer = setTimeout(() => deliver(ctx, armed), delay);
		countdownTimer = setInterval(() => renderWidget(ctx), 1000);
		renderWidget(ctx);
		notify(ctx, `waiting ${formatRemaining(delay)}`);
	}

	function restore(ctx: ExtensionContext, wait: PendingWait): void {
		if ("paused" in wait) {
			pending = wait;
			renderWidget(ctx);
			return;
		}
		if (!("dueAt" in wait)) {
			if (ctx.isIdle()) return arm(ctx, wait, wait.delay);
			pending = wait;
			renderWidget(ctx);
			return;
		}
		const delay = wait.dueAt - Date.now();
		if (delay <= 0) {
			pending = wait;
			deliver(ctx, wait);
			return;
		}
		pending = wait;
		deliveryTimer = setTimeout(() => deliver(ctx, wait), delay);
		countdownTimer = setInterval(() => renderWidget(ctx), 1000);
		renderWidget(ctx);
	}

	function cancel(ctx: ExtensionContext, announce: boolean): boolean {
		if (!pending) {
			clearWidget(ctx);
			if (announce) notify(ctx, "no queued wait");
			return false;
		}
		pending = undefined;
		clearTimers();
		clearWidget(ctx);
		persist(undefined);
		if (announce) notify(ctx, "queued wait cancelled");
		return true;
	}

	function schedule(ctx: ExtensionContext, delay: number, prompt: string, defer: boolean): void {
		cancel(ctx, false);
		if (defer) {
			pending = { prompt, delay };
			persist(pending);
			renderWidget(ctx);
			notify(ctx, "wait queued; timer starts after the agent settles");
			return;
		}
		arm(ctx, { prompt, delay }, delay);
	}

	function pause(ctx: ExtensionContext): void {
		if (!pending) return notify(ctx, "no queued wait");
		if ("paused" in pending) return notify(ctx, "wait already paused");
		if (!("dueAt" in pending)) return notify(ctx, "wait timer has not started yet");

		const remaining = Math.max(1, pending.dueAt - Date.now());
		pending = { prompt: pending.prompt, remaining, paused: true };
		persist(pending);
		clearTimers();
		renderWidget(ctx);
		notify(ctx, `wait paused with ${formatRemaining(remaining)} remaining`);
	}

	function resume(ctx: ExtensionContext): void {
		if (!pending) return notify(ctx, "no queued wait");
		if (!("paused" in pending)) return notify(ctx, "wait is not paused");

		const wait = pending;
		arm(ctx, wait, wait.remaining);
	}

	function status(ctx: ExtensionContext): void {
		if (!pending) return notify(ctx, "no queued wait");
		if ("paused" in pending) notify(ctx, `paused: ${formatRemaining(pending.remaining)} remaining\n${pending.prompt}`);
		else if (!("dueAt" in pending)) notify(ctx, `queued (starts after agent settles)\n${pending.prompt}`);
		else notify(ctx, `${formatRemaining(pending.dueAt - Date.now())} remaining\n${pending.prompt}`);
	}

	function reschedule(ctx: ExtensionContext, delay: number): void {
		if (!pending) return notify(ctx, "no queued wait to reschedule; provide a prompt", "error");
		if ("paused" in pending) {
			pending = { prompt: pending.prompt, remaining: delay, paused: true };
			persist(pending);
			renderWidget(ctx);
			return notify(ctx, `updated paused wait: ${formatRemaining(delay)} remaining`);
		}
		if (!("dueAt" in pending)) {
			pending = { prompt: pending.prompt, delay };
			persist(pending);
			renderWidget(ctx);
			return notify(ctx, "updated queued wait; timer starts after agent settles");
		}
		arm(ctx, pending, delay);
	}

	function handleCommand(args: string, ctx: ExtensionContext): void {
		const input = args.trim();
		if (!input || input === "status") return status(ctx);
		if (input === "cancel") return void cancel(ctx, true);
		if (input === "pause") return void pause(ctx);
		if (input === "resume") return void resume(ctx);
		if (input === "now") {
			if (!pending) return notify(ctx, "no queued wait");
			return void deliver(ctx, pending);
		}

		const separator = input.search(/\s/);
		if (separator < 0) {
			const delay = parseDuration(input);
			return void reschedule(ctx, delay);
		}

		const duration = input.slice(0, separator).trim();
		const prompt = input.slice(separator).trim();
		const delay = parseDuration(duration);
		schedule(ctx, delay, prompt, !ctx.isIdle());
	}

	pi.registerCommand("wait", {
		description: "Queue a prompt after a delay",
		handler(args, ctx) {
			handleCommand(args, ctx);
			return Promise.resolve();
		},
	});

	pi.on("session_start", (event, ctx) => {
		sessionContext = ctx;
		pending = undefined;
		clearTimers();
		clearWidget(ctx);
		if (event.reason === "reload") {
			const state = readWaitState(ctx.sessionManager.getBranch());
			if (state?.pending) restore(ctx, state.pending);
		} else {
			persist(undefined);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!pending || "dueAt" in pending || "paused" in pending) return;
		const wait = pending;
		arm(ctx, wait, wait.delay);
	});

	pi.on("session_shutdown", (event) => {
		if (event.reason !== "reload" && sessionContext) cancel(sessionContext, false);
		clearTimers();
		sessionContext = undefined;
	});
}
