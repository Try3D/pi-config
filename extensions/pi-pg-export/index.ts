import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Tracker } from "./tracker.ts";

/**
 * pi-pg-export: export interactive pi sessions (prompts, responses, thinking, tool
 * calls, LLM usage, and a lifecycle event timeline) to Postgres for auditability.
 *
 * Loaded as part of the pi-config package (`pi.extensions`). Configure with
 * PI_TRACKER_DATABASE_URL (see README); the migrations and dashboard live in the
 * separate pi-tracker app.
 */
export default function (pi: ExtensionAPI) {
	const tracker = new Tracker();

	// Session lifecycle
	pi.on("session_start", (event, ctx) => tracker.start(event, ctx));
	pi.on("session_shutdown", (event, ctx) => tracker.stop(event, ctx));
	pi.on("session_info_changed", (event, ctx) => tracker.sessionInfoChanged(event, ctx));

	// LLM messages (assistant responses -> llm_calls)
	pi.on("message_start", (event, ctx) => tracker.messageStart(event, ctx));
	pi.on("message_update", (event, ctx) => tracker.messageUpdate(event, ctx));
	pi.on("message_end", (event, ctx) => tracker.messageEnd(event, ctx));

	// Tool calls
	pi.on("tool_execution_start", (event, ctx) => tracker.toolStart(event, ctx));
	pi.on("tool_execution_end", (event, ctx) => tracker.toolEnd(event, ctx));

	// Turn boundaries flush newly appended session entries
	pi.on("turn_start", (event, ctx) => tracker.turnStart(event, ctx));
	pi.on("turn_end", (event, ctx) => tracker.turnEnd(event, ctx));
	pi.on("agent_end", (event, ctx) => tracker.agentEnd(event, ctx));
	pi.on("agent_settled", (event, ctx) => tracker.agentSettled(event, ctx));

	// Audit timeline events
	pi.on("after_provider_response", (event, ctx) => tracker.providerResponse(event, ctx));
	pi.on("before_provider_request", (event, ctx) => tracker.providerRequest(event, ctx));
	pi.on("model_select", (event, ctx) => tracker.modelSelect(event, ctx));
	pi.on("thinking_level_select", (event, ctx) => tracker.thinkingLevel(event, ctx));
	pi.on("input", (event, ctx) => tracker.input(event, ctx));
	pi.on("user_bash", (event, ctx) => tracker.userBash(event, ctx));
}
