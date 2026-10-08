/**
 * Child-side settle hook.
 *
 * When this pi process was launched by pi-subagents (PI_SUBAGENT_RUN_DIR set),
 * report the final assistant text to the parent by writing result.json on
 * agent_settled, then keep the pane alive for a window of inactivity so the user
 * can read the result, send a follow-up, or ask a question. Any new activity
 * (a turn, a submitted prompt, a blocking dialog) resets the window.
 *
 * The parent watches result.json and posts a notification; follow-ups arrive as
 * ordinary pasted input in this pane, which Pi queues as steering mid-turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Idle window before a finished subagent pane shuts itself down (~10 minutes of inactivity). */
const DEFAULT_KEEPALIVE_MS = 10 * 60 * 1000;

interface ChildResult {
	status: "done" | "failed";
	text: string;
	stopReason?: string;
	sessionId: string;
	sessionFile?: string;
	finishedAt: string;
}

export function installChildHook(pi: ExtensionAPI): void {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	if (!runDir) return;

	// The launcher passes `--session-id <runId>` with the run dir named after it, so
	// only the process actually launched for this run may report its result (a
	// second pi started in the kept-alive pane must not clobber it).
	const runId = path.basename(runDir);
	const rawKeepAlive = Number(process.env.PI_SUBAGENT_KEEPALIVE_MS);
	const keepAliveMs = Number.isFinite(rawKeepAlive) && rawKeepAlive >= 0 ? rawKeepAlive : DEFAULT_KEEPALIVE_MS;
	const resultPath = path.join(runDir, "result.json");
	let lastText = "";
	let lastStopReason: string | undefined;
	let settled = false;
	let turnActive = false;
	let promptActive = false;
	let started = false;
	let ctxRef: ExtensionContext | undefined;
	let timer: NodeJS.Timeout | undefined;

	const disarm = (): void => {
		if (timer) clearTimeout(timer);
		timer = undefined;
	};
	const arm = (): void => {
		disarm();
		if (settled && !turnActive && !promptActive && ctxRef) timer = setTimeout(() => ctxRef?.shutdown(), keepAliveMs);
	};

	const writeResult = (ctx: ExtensionContext, status: ChildResult["status"]): void => {
		if (ctx.sessionManager.getSessionId() !== runId) return;
		const result: ChildResult = {
			status,
			text: lastText,
			stopReason: lastStopReason,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			finishedAt: new Date().toISOString(),
		};
		try {
			fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
		} catch {
			/* run dir may have been pruned */
		}
	};

	// True inactivity: reset the window on any keystroke, not only on a submit.
	// The event API has no per-keystroke hook, so listen to the TUI input stream.
	let detachInput: (() => void) | undefined;
	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		if (ctx.mode !== "tui" || detachInput) return;
		try {
			await ctx.ui.custom<void>((instance, _theme, _keybindings, done) => {
				detachInput = instance.addInputListener(() => {
					if (turnActive || promptActive) disarm();
					else arm();
					return undefined;
				});
				done(undefined);
				return { render: () => [], invalidate: () => {} };
			});
		} catch {
			/* no TUI input stream available */
		}
	});

	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		lastText = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
		lastStopReason = message.stopReason;
	});

	pi.on("input", () => {
		if (turnActive || promptActive) disarm();
		else arm();
	});
	pi.on("agent_start", () => {
		turnActive = true;
		disarm();
	});
	pi.on("turn_start", () => {
		started = true;
		turnActive = true;
		lastText = "";
		lastStopReason = undefined;
		disarm();
	});
	pi.on("ui_prompt_start", () => {
		promptActive = true;
		disarm();
	});
	pi.on("ui_prompt_end", () => {
		promptActive = false;
		arm();
	});

	pi.on("agent_settled", (_event, ctx) => {
		ctxRef = ctx;
		settled = true;
		turnActive = false;
		// Only a clean stop is success; `length` (truncated by max tokens) or any
		// other terminal reason is reported as a failure.
		writeResult(ctx, lastStopReason === "stop" ? "done" : "failed");
		arm();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		detachInput?.();
		detachInput = undefined;
		disarm();
		if (started && turnActive) writeResult(ctx, "failed");
	});
}
