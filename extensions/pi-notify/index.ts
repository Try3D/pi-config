/**
 * macOS notifications for pi.
 * - agent_settled: "finished" when pi will not continue automatically
 * - ui_prompt_start: "needs attention" when a blocking prompt appears
 *
 * Subagent panes (PI_SUBAGENT_RUN_DIR set) do not send the "finished"
 * notification. Their parent reports each result, so a notification for every
 * run would be redundant. Prompts still notify because they block.
 *
 * Prompts that close within PROMPT_NOTIFY_DELAY_MS do not notify. Extensions
 * sometimes open a no-op custom overlay to get a TUI handle (the sidebar does
 * this on every session_start), which otherwise notifies on every startup,
 * /reload, and /new.
 *
 * Title uses the project folder name so you know which window finished.
 * Only interactive sessions (tui/rpc) notify. Headless SDK/print runs also load
 * this extension, and those produced spurious notifications from scripts like
 * pibox/scripts/test-drive.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;

	// Pass text as argv, not interpolated into the script, because model output can
	// contain quotes/backslashes and must never be parsed as AppleScript.
	const NOTIFY_SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title (item 2 of argv) sound name "Sosumi"\nend run';
	const notify = (title: string, body: string) =>
		// Ignored callback. Swallow osascript errors so an emitted `error` event
		// never crashes the pi session.
		execFile("osascript", ["-e", NOTIFY_SCRIPT, "--", body, title], () => {});

	// agent_settled carries no payload, so remember the last stop reason from
	// agent_end and skip notifying when the run was interrupted (Esc). Also
	// grab the final assistant text so the notification starts with the message.
	let stopReason: string | undefined;
	let lastText: string | undefined;

	pi.on("agent_end", (event) => {
		stopReason = undefined;
		lastText = undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (!message || message.role !== "assistant") continue;
			stopReason = message.stopReason;
			lastText = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			break;
		}
	});

	const isInteractive = (ctx: { mode: string }) => ctx.mode === "tui" || ctx.mode === "rpc";
	const preview = (text: string | undefined) =>
		text ? (text.length > 140 ? `${text.slice(0, 139)}…` : text) : "Finished";

	pi.on("agent_settled", (_event, ctx) => {
		// Do not notify when a subagent pane finishes. Its parent reports the result.
		if (process.env.PI_SUBAGENT_RUN_DIR) return;
		if (!isInteractive(ctx) || stopReason === "aborted") return;
		notify(`π ${basename(ctx.cwd)}`, preview(lastText));
	});

	// A real blocking prompt stays open until the user acts; a throwaway overlay
	// ends in the same tick. Debounce so only the former notifies.
	const PROMPT_NOTIFY_DELAY_MS = 500;
	let promptNotifyTimer: ReturnType<typeof setTimeout> | undefined;

	pi.on("ui_prompt_start", (_event, ctx) => {
		if (!isInteractive(ctx)) return;
		const title = `π ${basename(ctx.cwd)}`;
		clearTimeout(promptNotifyTimer);
		promptNotifyTimer = setTimeout(() => {
			promptNotifyTimer = undefined;
			notify(title, "Needs your attention");
		}, PROMPT_NOTIFY_DELAY_MS);
	});

	pi.on("ui_prompt_end", () => {
		clearTimeout(promptNotifyTimer);
		promptNotifyTimer = undefined;
	});

	pi.on("session_shutdown", () => {
		clearTimeout(promptNotifyTimer);
		promptNotifyTimer = undefined;
	});
}
