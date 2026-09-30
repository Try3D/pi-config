/**
 * Human-facing commands: `/agent:<name> <task>` runs one named agent, `/agents`
 * lists them. Registration happens once per process (see index.ts) because pi
 * keeps duplicate command names and suffixes them (`/agent:scout:2`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.ts";
import { runSubagent, type RunResult } from "./run.ts";

export function scopeFor(ctx: { isProjectTrusted(): boolean }): AgentScope {
	return ctx.isProjectTrusted() ? "both" : "user";
}

export function resultText(result: RunResult): string {
	const sections: string[] = [];
	if (result.text.trim()) sections.push(result.text.trim());
	if (result.changes) sections.push(`Changed files:\n${result.changes}`);
	return sections.join("\n\n") || "(no output)";
}

/** Human-readable failure for a run that did not finish cleanly. */
export function failureText(agent: AgentConfig, result: RunResult): string {
	const partial = result.text.trim() ? `\n\nPartial output:\n${result.text.trim().slice(-2000)}` : "";
	const state = result.timedOut ? "timed out" : `exited with code ${result.exitCode ?? "unknown"}`;
	return `Subagent "${agent.name}" ${state} (pane ${result.paneId}, run dir ${result.runDir}).${partial}`;
}

/** Live command-triggered runs, so session shutdown can abort them. */
const activeRuns = new Set<AbortController>();

export function abortActiveRuns(): void {
	for (const controller of activeRuns) controller.abort();
	activeRuns.clear();
}

async function executeAgent(pi: ExtensionAPI, agent: AgentConfig, task: string, ctx: ExtensionContext): Promise<RunResult> {
	if (ctx.hasUI) ctx.ui.setStatus("pi-agents", `Running ${agent.name}...`);
	const controller = new AbortController();
	activeRuns.add(controller);
	try {
		const result = await runSubagent({ ctx, agent, task, signal: controller.signal });
		if (result.timedOut || result.exitCode !== 0) throw new Error(failureText(agent, result));
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
		activeRuns.delete(controller);
		if (ctx.hasUI) ctx.ui.setStatus("pi-agents", undefined);
	}
}

/** Register `/agents` and one `/agent:<name>` command per discovered agent. */
export function registerAgentCommands(pi: ExtensionAPI, source: ExtensionContext): void {
	const scope = scopeFor(source);
	const agents = discoverAgents(source.cwd, scope);

	pi.registerCommand("agents", {
		description: "List available subagents",
		// eslint-disable-next-line @typescript-eslint/require-await -- command handlers must return a promise
		handler: async (_args, cmdCtx) => {
			const list = discoverAgents(cmdCtx.cwd, scopeFor(cmdCtx));
			const text = list.map((a) => `/agent:${a.name}: ${a.description}`).join("\n") || "No agents found.";
			cmdCtx.ui.notify(text, "info");
		},
	});

	// A project agent silently replaces a same-named user agent, so warn about it.
	if (scope === "both") {
		const userNames = new Set(discoverAgents(source.cwd, "user").map((a) => a.name));
		const shadowed = agents.filter((a) => a.source === "project" && userNames.has(a.name)).map((a) => a.name);
		if (shadowed.length > 0) {
			source.ui.notify(`Project agents override user agents: ${shadowed.join(", ")}`, "warning");
		}
	}

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
}
