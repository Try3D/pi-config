/**
 * pi-agents: tmux-native subagents for pi.
 *
 * - `subagent` tool: the LLM can delegate a task to a named agent.
 * - `/agent:<name> <task>` commands: the human can directly run a named agent.
 *
 * Each subagent runs a separate `pi` session in a tiled tmux pane of the
 * current session (4 panes per tab). The parent collects the final text and a
 * git change summary.
 *
 * Module split: agents.ts (agent discovery), script.ts (run.sh generation),
 * jsonl.ts (raw.jsonl parsing), tmux.ts (pane allocation), changes.ts (git
 * summary), run.ts (subagent lifecycle), commands.ts (/agent:<name> commands),
 * index.ts (tool registration + wiring).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents } from "./agents.ts";
import { abortActiveRuns, failureText, registerAgentCommands, resultText, scopeFor } from "./commands.ts";
import { runSubagent } from "./run.ts";

/** Commands can only be registered once per process, since pi suffixes duplicates. */
let commandsRegistered = false;

export default function (pi: ExtensionAPI) {
	// LLM-facing tool
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate a task to a specialized subagent. Runs a separate pi session in a tmux pane of the current session, streams its progress there, and returns the subagent's final text plus a summary of the files it changed.",
		promptSnippet: "Delegate a task to a specialized subagent running in a tmux pane",
		promptGuidelines: [
			"Use subagent to delegate self-contained tasks to a specialized agent; it runs in the current tmux session and returns its final text plus changed files.",
		],
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent definition to invoke" }),
			task: Type.String({ description: "Task to delegate to the agent" }),
			cwd: Type.Optional(Type.String({ description: "Working directory for the subagent (defaults to cwd)" })),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd, scopeFor(ctx));
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n") || "none";
				throw new Error(`Unknown agent "${params.agent}". Available agents:\n${available}`);
			}

			const result = await runSubagent({
				ctx,
				agent,
				task: params.task,
				cwd: params.cwd,
				signal,
				onUpdate: (text) => {
					onUpdate?.({
						content: [{ type: "text", text: text || "(running...)" }],
						details: { agent: agent.name },
					});
				},
			});

			if (result.timedOut || result.exitCode !== 0) throw new Error(failureText(agent, result));

			return {
				content: [{ type: "text", text: resultText(result) }],
				details: {
					agent: agent.name,
					source: agent.source,
					paneId: result.paneId,
					exitCode: result.exitCode,
					changes: result.changes,
					runDir: result.runDir,
				},
			};
		},
	});

	// Human-facing commands: /agent:<name> <task>
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
