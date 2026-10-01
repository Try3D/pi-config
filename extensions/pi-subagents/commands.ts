/**
 * Human-facing commands: `/agents` lists agents and manages past runs, and
 * `/agent:<name> <task>` runs one named agent. Registration happens once per
 * process (see index.ts) because pi keeps duplicate command names and suffixes
 * them (`/agent:scout:2`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentScope } from "./agents.ts";
import { currentDepth, listRuns, openRunSession, resumeSubagent, runSubagent, type RunResult } from "./run.ts";

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
export function failureText(result: RunResult): string {
	const partial = result.text.trim() ? `\n\nPartial output:\n${result.text.trim().slice(-2000)}` : "";
	const state = result.timedOut ? "timed out" : "failed";
	return `Subagent "${result.agent}" ${state}.${partial}`;
}

/** Live command-triggered runs, so session shutdown can abort them. */
const activeRuns = new Set<AbortController>();

export function abortActiveRuns(): void {
	for (const controller of activeRuns) controller.abort();
	activeRuns.clear();
}

/** Run a controller-tracked subagent and post a follow-up message with the result. */
async function deliver(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	status: string,
	run: (signal: AbortSignal) => Promise<RunResult>,
): Promise<void> {
	if (ctx.hasUI) ctx.ui.setStatus("pi-subagents", status);
	const controller = new AbortController();
	activeRuns.add(controller);
	try {
		const result = await run(controller.signal);
		if (result.timedOut || result.status === "failed") throw new Error(failureText(result));
		pi.sendMessage(
			{
				customType: "pi-subagents",
				content: `**${result.agent}**\n\n${resultText(result)}`,
				display: true,
				details: { agent: result.agent, paneId: result.paneId, changes: result.changes },
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	} finally {
		activeRuns.delete(controller);
		if (ctx.hasUI) ctx.ui.setStatus("pi-subagents", undefined);
	}
}

function listRunLines(): string {
	const runs = listRuns(15);
	if (runs.length === 0) return "No subagent runs found.";
	return runs
		.map((run) => `${run.status.padEnd(7)} ${run.runId}  ${run.agent}: ${run.task.replace(/\s+/g, " ").trim().slice(0, 60)}`)
		.join("\n");
}

/** Register `/agents` and one `/agent:<name>` command per discovered agent. */
export function registerAgentCommands(pi: ExtensionAPI, source: ExtensionContext): void {
	const scope = scopeFor(source);
	const agents = discoverAgents(source.cwd, scope);

	pi.registerCommand("agents", {
		description: "List subagents, or manage runs: /agents runs | /agents open <runId> | /agents resume <runId> <task>",
		handler: async (args, cmdCtx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "runs") {
				cmdCtx.ui.notify(listRunLines(), "info");
				return;
			}
			if (sub === "open") {
				const runId = rest[0];
				if (!runId) {
					cmdCtx.ui.notify("Usage: /agents open <runId>", "error");
					return;
				}
				try {
					const paneId = await openRunSession(runId, currentDepth() + 1);
					cmdCtx.ui.notify(`Opened ${runId} in pane ${paneId}`, "info");
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (sub === "resume") {
				const runId = rest[0];
				const task = rest.slice(1).join(" ");
				if (!runId || !task) {
					cmdCtx.ui.notify("Usage: /agents resume <runId> <task>", "error");
					return;
				}
				try {
					await deliver(pi, cmdCtx, `Resuming ${runId}...`, (signal) =>
						resumeSubagent({ ctx: cmdCtx, runId, task, depth: currentDepth() + 1, signal }),
					);
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
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
					await deliver(pi, cmdCtx, `Running ${agent.name}...`, (signal) =>
						runSubagent({ ctx: cmdCtx, agent, task, depth: currentDepth() + 1, signal }),
					);
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	}
}
