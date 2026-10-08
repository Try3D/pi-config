/**
 * pi-subagents: tmux-native subagents for pi.
 *
 * - `subagent` tool: delegate a task to a named agent, or send a message to an
 *   existing run by passing `agent_id`. Always runs in the background; the tool
 *   returns a run id immediately and the child pastes its result into this pane
 *   when it settles.
 * - `/agent:<name> <task>` commands: the human can directly run a named agent.
 *
 * Each subagent runs a real interactive pi session in its own tmux window of
 * the current session.
 *
 * - parent -> child: the parent pastes the message into the child's tmux pane;
 *   Pi queues it as steering when the child is mid-turn.
 * - child -> parent: the child writes `<runDir>/result.json`; the parent's
 *   watcher posts a follow-up notification when it appears.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgent } from "./agents.ts";
import { installChildHook } from "./child.ts";
import { registerAgentCommands, scopeFor } from "./commands.ts";
import { currentDepth, MAX_SUBAGENT_DEPTH, restoreBackgroundWatchers, runSubagentBackground, sendToRun, startBackgroundWatcher, stopAllBackgroundWatchers } from "./run.ts";

/** Commands can only be registered once per process, since pi suffixes duplicates. */
let commandsRegistered = false;

export default function (pi: ExtensionAPI) {
	installChildHook(pi);

	// A child at the depth limit gets no way to spawn further subagents.
	if (currentDepth() < MAX_SUBAGENT_DEPTH) {
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description:
				"Delegate a task to a specialized subagent, or continue an existing one. Always runs in the background: the tool returns a run_id immediately and you are notified when it completes. Pass agent_id to send a message to a run you already started.",
			promptSnippet: "Delegate a task to a specialized subagent running in an isolated session",
			promptGuidelines: [
				"Use subagent to delegate self-contained tasks to a specialized agent.",
				"Subagents run in the background. You get a run_id immediately and a notification when the agent completes.",
				"Pass agent_id to send a follow-up message to a subagent you already started.",
				"Every subagent call returns a run_id. Pass it back as agent_id to continue that same conversation.",
			],
			parameters: Type.Object({
				agent: Type.Optional(Type.String({ description: "Agent definition to invoke (defaults to the built-in general agent)" })),
				task: Type.String({ description: "Task for a new run, or the message to send to an existing run" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to cwd)" })),
				agent_id: Type.Optional(Type.String({ description: "Run id of an existing subagent to send this message to" })),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const depth = currentDepth() + 1;

				if (params.agent_id) {
					const handle = await sendToRun({ runId: params.agent_id, task: params.task, depth });
					startBackgroundWatcher(pi, handle.runId);
					return {
						content: [{ type: "text", text: `Sent to subagent ${handle.runId}.\nUse agent_id ${handle.runId} for further messages.` }],
						details: { agent: handle.agent, runId: handle.runId, status: "running" },
					};
				}

				const agent = resolveAgent(ctx.cwd, scopeFor(ctx), params.agent);
				const handle = await runSubagentBackground({ ctx, agent, task: params.task, cwd: params.cwd, depth });
				startBackgroundWatcher(pi, handle.runId);
				return {
					content: [
						{
							type: "text",
							text: `Started subagent in background.\nRun ID: ${handle.runId}\nAgent: ${agent.name}\nPass this Run ID back as agent_id to send follow-ups.`,
						},
					],
					details: { agent: agent.name, source: agent.source, runId: handle.runId, status: "running" },
				};
			},
		});
	}

	// Human-facing commands: /agents, /agent:<name> <task>
	pi.on("session_start", (event, ctx) => {
		if (commandsRegistered) return;
		commandsRegistered = true;
		registerAgentCommands(pi, ctx);
		// Reloaded sessions may have background runs that started before the reload;
		// restart watchers so their completion notifications still land. Stale runs
		// whose pane already died are marked failed silently instead of notifying.
		if (event.reason === "reload") void restoreBackgroundWatchers(pi);
	});

	pi.on("session_shutdown", () => {
		stopAllBackgroundWatchers();
	});
}
