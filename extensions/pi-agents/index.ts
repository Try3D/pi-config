/**
 * pi-agents — tmux-native subagents for pi.
 *
 * - `subagent` tool: the LLM can delegate a task to a named agent.
 * - `/agent:<name> <task>` commands: the human can directly run a named agent.
 *
 * Each subagent runs a separate `pi` session in a tiled tmux pane of the
 * current session (4 panes per tab). The parent collects the final text and a
 * git change summary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.ts";
import { runSubagent, type RunResult } from "./run.ts";

function scopeFor(ctx: { isProjectTrusted(): boolean }): AgentScope {
	return ctx.isProjectTrusted() ? "both" : "user";
}

function resultText(result: RunResult): string {
	const sections: string[] = [];
	if (result.text.trim()) sections.push(result.text.trim());
	if (result.changes) sections.push(`Changed files:\n${result.changes}`);
	return sections.join("\n\n") || "(no output)";
}

async function executeAgent(
	pi: ExtensionAPI,
	agent: AgentConfig,
	task: string,
	ctx: Parameters<typeof runSubagent>[0]["ctx"],
): Promise<RunResult> {
	if (ctx.hasUI) ctx.ui.setStatus("pi-agents", `Running ${agent.name}...`);
	try {
		const result = await runSubagent({ ctx, agent, task });
		if (result.timedOut) throw new Error(`Subagent "${agent.name}" timed out (pane ${result.paneId}).`);
		if (result.exitCode !== 0) {
			throw new Error(`Subagent "${agent.name}" exited with code ${result.exitCode} (pane ${result.paneId}).`);
		}
		pi.sendMessage(
			{
				customType: "pi-agents",
				content: `**${agent.name}** (${agent.source})\n\n${resultText(result)}`,
				display: true,
				details: { agent: agent.name, paneId: result.paneId, changes: result.changes },
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
		return result;
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("pi-agents", undefined);
	}
}

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
				cwd: params.cwd ? params.cwd : undefined,
				signal,
				onUpdate: (text) => {
					onUpdate?.({
						content: [{ type: "text", text: text || "(running...)" }],
						details: { agent: agent.name },
					});
				},
			});

			if (result.timedOut) throw new Error(`Subagent "${agent.name}" timed out (pane ${result.paneId}).`);
			if (result.exitCode !== 0) {
				throw new Error(`Subagent "${agent.name}" exited with code ${result.exitCode} (pane ${result.paneId}).`);
			}

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
	pi.on("session_start", async (_event, ctx) => {
		const agents = discoverAgents(ctx.cwd, scopeFor(ctx));

		pi.registerCommand("agents", {
			description: "List available subagents",
			handler: async (_args, cmdCtx) => {
				const list = discoverAgents(cmdCtx.cwd, scopeFor(cmdCtx));
				const text =
					list.map((a) => `/${"agent:"}${a.name} — ${a.description}`).join("\n") || "No agents found.";
				cmdCtx.ui.notify(text, "info");
			},
		});

		for (const agent of agents) {
			pi.registerCommand(`agent:${agent.name}`, {
				description: `Run the ${agent.name} subagent: ${agent.description}`,
				handler: async (args, cmdCtx) => {
					let task = args.trim();
					if (!task) {
						if (!cmdCtx.hasUI) {
							cmdCtx.ui.notify(`Usage: /agent:${agent.name} <task>`, "error");
							return;
						}
						const input = await cmdCtx.ui.input(`Task for ${agent.name}:`, "");
						if (!input?.trim()) return;
						task = input.trim();
					}
					try {
						await executeAgent(pi, agent, task, cmdCtx);
					} catch (error) {
						cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				},
			});
		}
	});
}
