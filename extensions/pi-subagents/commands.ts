/**
 * Human-facing commands: `/agents` lists agents and manages past runs,
 * `/agent:<name> <task>` runs one named agent in the background,
 * `/agents resume|steer <runId> <task>` sends a message to an existing run
 * (pasted into its pane), and `/agents status <runId>` reads its result.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentScope } from "./agents.ts";
import { cancelSubagent, currentDepth, getSubagentStatus, listRuns, openRunSession, runSubagentBackground, sendToRun, startBackgroundWatcher } from "./run.ts";

export function scopeFor(ctx: { isProjectTrusted(): boolean }): AgentScope {
	return ctx.isProjectTrusted() ? "both" : "user";
}

function listRunLines(): string {
	const runs = listRuns(15);
	if (runs.length === 0) return "No subagent runs found.";
	return runs
		.map((run) => `${run.status.padEnd(7)} ${run.runId}  ${run.agent}: ${run.task.replace(/\s+/g, " ").trim().slice(0, 60)}`)
		.join("\n");
}

function formatRunIdLine(runId: string): string {
	return `Started subagent in background.\nRun ID: ${runId}\nUse \`/agents resume ${runId} <task>\` to send a follow-up, or \`/agents status ${runId}\` to check progress.`;
}

/** Register `/agents` and one `/agent:<name>` command per discovered agent. */
export function registerAgentCommands(pi: ExtensionAPI, source: ExtensionContext): void {
	const scope = scopeFor(source);
	const agents = discoverAgents(source.cwd, scope);

	pi.registerCommand("agents", {
		description:
			"List subagents, or manage runs: /agents runs | /agents open <runId> | /agents resume <runId> <task> | /agents steer <runId> <task> | /agents status <runId> | /agents cancel <runId>",
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
			if (sub === "resume" || sub === "steer") {
				const runId = rest[0];
				const task = rest.slice(1).join(" ");
				if (!runId || !task) {
					cmdCtx.ui.notify(`Usage: /agents ${sub} <runId> <task>`, "error");
					return;
				}
				try {
					const handle = await sendToRun({ runId, task, depth: currentDepth() + 1 });
					startBackgroundWatcher(pi, handle.runId);
					cmdCtx.ui.notify(`Sent to ${handle.runId}.`, "info");
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (sub === "status") {
				const runId = rest[0];
				if (!runId) {
					cmdCtx.ui.notify("Usage: /agents status <runId>", "error");
					return;
				}
				try {
					const status = await getSubagentStatus(runId);
					const lines = [
						`${status.status.padEnd(7)} ${status.runId}  ${status.agent}`,
						status.text ? `Output:\n${status.text.slice(0, 1200)}` : undefined,
					].filter(Boolean);
					cmdCtx.ui.notify(lines.join("\n\n"), "info");
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (sub === "cancel") {
				const runId = rest[0];
				if (!runId) {
					cmdCtx.ui.notify("Usage: /agents cancel <runId>", "error");
					return;
				}
				try {
					await cancelSubagent(runId);
					cmdCtx.ui.notify(`Cancelled ${runId}.`, "info");
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
			description: `Run the ${agent.name} subagent in the background: /agent:${agent.name} <task>`,
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
					const handle = await runSubagentBackground({ ctx: cmdCtx, agent, task, depth: currentDepth() + 1 });
					startBackgroundWatcher(pi, handle.runId);
					cmdCtx.ui.notify(formatRunIdLine(handle.runId), "info");
				} catch (error) {
					cmdCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
		});
	}
}
