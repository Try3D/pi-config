/**
 * Agent definition discovery for pi-subagents.
 *
 * Agents are markdown files with YAML frontmatter:
 *
 *   ---
 *   name: worker
 *   description: General-purpose subagent
 *   model: opencode-go/deepseek-v4.1-flash
 *   tools: read, grep, find, ls, bash, edit, write
 *   ---
 *   System prompt...
 *
 * Locations:
 *   ~/.pi/agent/agents/*.md   (user, always loaded)
 *   .pi/agents/*.md           (project, only when trusted)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

/** Only alphanumeric/dot/dash/underscore names are loadable (safe for paths, ids, commands). */
const AGENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

interface AgentFrontmatter {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	[key: string]: unknown;
}

function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (
			!entry.isFile() &&
			!entry.isSymbolicLink() // accept symlink targets; unreadable ones are skipped below
		)
			continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
		// Reject names that cannot round-trip through `/agent:<name>` or a session id.
		if (!AGENT_NAME_RE.test(frontmatter.name)) continue;

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}
	return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	const home = process.env.HOME;
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* keep walking */
		}
		// Stop at the repository root (or home/root) so an unrelated ancestor's
		// .pi/agents cannot inject agent definitions.
		if (fs.existsSync(path.join(dir, ".git")) || dir === home) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
	const projectDir = findNearestProjectAgentsDir(cwd);
	const projectAgents =
		scope === "user" || !projectDir ? [] : loadAgentsFromDir(projectDir, "project");

	const map = new Map<string, AgentConfig>();
	const overridden: string[] = [];
	for (const a of userAgents) {
		if (map.has(a.name)) overridden.push(a.name);
		map.set(a.name, a);
	}
	for (const a of projectAgents) {
		if (map.has(a.name)) overridden.push(a.name);
		map.set(a.name, a); // project overrides on "both"
	}
	if (overridden.length > 0) {
		// Two agents sharing a name but behaving differently is confusing, so warn
		// about overrides even when the later definition is intended.
		console.warn(
			`[pi-subagents] duplicate agent names ignored (later definition wins): ${overridden.join(", ")}`,
		);
	}
	return Array.from(map.values());
}

/** Built-in fallback used when the caller does not name an agent. */
export const GENERIC_AGENT: AgentConfig = {
	name: "general",
	description: "General-purpose subagent",
	systemPrompt: "You are a general-purpose subagent operating in an isolated context window. Complete the task autonomously.",
	source: "builtin",
	filePath: "",
};

/** Resolve an agent by name, or the built-in general agent when none is given. */
export function resolveAgent(cwd: string, scope: AgentScope, name?: string): AgentConfig {
	if (!name) return GENERIC_AGENT;
	const agents = discoverAgents(cwd, scope);
	const agent = agents.find((a) => a.name === name);
	if (agent) return agent;
	const available = agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("\n") || "none";
	throw new Error(`Unknown agent "${name}". Available agents:\n${available}`);
}
