/**
 * macOS notifications for pi.
 * - agent_settled -> "finished" (fires only when pi will not continue automatically)
 * - ui_prompt_start -> "needs attention" (blocking prompt appeared)
 *
 * Title uses the project folder name so you know which window finished.
 * Only interactive sessions (tui/rpc) notify: headless SDK/print runs also load
 * this extension, which caused spurious notifications from scripts like
 * pibox/scripts/test-drive.ts.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";

export default function (pi: ExtensionAPI) {
	if (process.platform !== "darwin") return;

	const notify = (title: string, body: string) =>
		execFile("osascript", [
			"-e",
			`display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Sosumi"`,
		]);

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
			if (message.role !== "assistant") continue;
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
		if (!isInteractive(ctx) || stopReason === "aborted") return;
		notify(`π ${basename(ctx.cwd)}`, preview(lastText));
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		if (!isInteractive(ctx)) return;
		notify(`π ${basename(ctx.cwd)}`, "Needs your attention");
	});
}
