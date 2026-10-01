/**
 * pi-subagents: tmux-native subagents for pi.
 *
 * - `subagent` tool: the LLM can delegate a task to a named agent, or resume a
 *   previous run with `resume`.
 * - `/agent:<name> <task>` commands: the human can directly run a named agent.
 *
 * Each subagent runs a real interactive pi session in its own tmux window of
 * the current session. The parent blocks until the child reports completion,
 * then returns the final text plus a git change summary. The pane stays live for
 * a short idle window so it can be read or resumed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { installChildHook } from "./child.ts";
import { abortActiveRuns, failureText, registerAgentCommands, resultText, scopeFor } from "./commands.ts";
import { currentDepth, MAX_SUBAGENT_DEPTH, resumeSubagent, runSubagent } from "./run.ts";

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
				"Delegate a task to a specialized subagent. Runs an interactive pi session and returns the subagent's final text, an `agent_id` to continue the conversation, and a summary of the files it changed.",
			promptSnippet: "Delegate a task to a specialized subagent running in an isolated session",
			promptGuidelines: [
				"Use subagent to delegate self-contained tasks to a specialized agent; it returns its final text plus changed files.",
				"Every subagent call returns an `agent_id`. Pass it back as `agent_id` to continue that same conversation.",
			],
			parameters: Type.Object({
				agent: Type.Optional(Type.String({ description: "Name of the agent definition to invoke (required unless continuing a conversation)" })),
				task: Type.String({ description: "Task or follow-up message for the agent" }),
				cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to cwd)" })),
				agent_id: Type.Optional(Type.String({ description: "Id of a previous subagent conversation to continue (returned by every subagent call)" })),
				resume: Type.Optional(Type.String({ description: "Alias of agent_id" })),
			}),

			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const depth = currentDepth() + 1;
				const onText = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: {} });
				// `agent_id` is the continuation handle; `resume` is a legacy alias.
				const conversationId = params.agent_id ?? params.resume;
				const withId = (result: { runId: string }, text: string) =>
					`${text}\n\nagent id: ${result.runId}\ncontinue this conversation: subagent({ agent_id: "${result.runId}", task: "…" })`;

				if (conversationId) {
					const result = await resumeSubagent({ ctx, runId: conversationId, task: params.task, depth, signal, onUpdate: onText });
					if (result.timedOut || result.status === "failed") throw new Error(failureText(result));
					return {
						content: [{ type: "text", text: withId(result, resultText(result)) }],
						details: {
							agent: result.agent,
							resumed: conversationId,
							runId: result.runId,
							changes: result.changes,
							runDir: result.runDir,
						},
					};
				}

				const agents = discoverAgents(ctx.cwd, scopeFor(ctx));
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n") || "none";
					throw new Error(`Unknown agent "${params.agent ?? ""}". Available agents:\n${available}`);
				}

				const result = await runSubagent({ ctx, agent, task: params.task, cwd: params.cwd, depth, signal, onUpdate: onText });
				if (result.timedOut || result.status === "failed") throw new Error(failureText(result));

				return {
					content: [{ type: "text", text: withId(result, resultText(result)) }],
					details: {
						agent: agent.name,
						source: agent.source,
						runId: result.runId,
						changes: result.changes,
						runDir: result.runDir,
					},
				};
			},
		});
	}

	// Human-facing commands: /agents, /agent:<name> <task>
	pi.on("session_start", (_event, ctx) => {
		if (commandsRegistered) return;
		commandsRegistered = true;
		registerAgentCommands(pi, ctx);
	});

	// Abort command-triggered runs that are still waiting when the session exits.
	pi.on("session_shutdown", () => {
		abortActiveRuns();
	});
}
