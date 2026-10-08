/**
 * Turns session messages into the text the classifier sees. Shared by the live
 * extension and the offline backfill so both build identical states.
 */

const MAX_TEXT = 240;
const MAX_THINKING = 400;
export const MAX_ARGS = 160;

export type LooseMessage = { role?: string; content?: unknown };

export function clamp(text: string, max: number): string {
	return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function partText(content: unknown, kind: "text" | "thinking"): string {
	if (kind === "text" && typeof content === "string") return clamp(content, MAX_TEXT);
	if (!Array.isArray(content)) return "";
	const joined = (content as unknown[])
		.filter((part): part is { type: string; text?: string; thinking?: string } => {
			if (typeof part !== "object" || part === null || !("type" in part)) return false;
			return part.type === kind;
		})
		.map((part) => (kind === "thinking" ? (part.thinking ?? "") : (part.text ?? "")))
		.join(" ");
	return clamp(joined, kind === "thinking" ? MAX_THINKING : MAX_TEXT);
}

function toolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return (content as unknown[])
		.filter((part): part is { type: "toolCall"; name: string; arguments?: unknown } => {
			if (typeof part !== "object" || part === null || !("type" in part) || !("name" in part)) return false;
			const { type, name } = part;
			return type === "toolCall" && typeof name === "string";
		})
		.map((part) => `the agent called the ${part.name} tool${part.arguments ? ` with ${clamp(JSON.stringify(part.arguments), MAX_ARGS)}` : ""}`);
}

/** The prompt, reasoning, words, and tool calls in one message. */
function messageLines(message: LooseMessage | undefined): string[] {
	if (!message) return [];
	const role = message.role ?? "?";
	const lines: string[] = [];
	const thinking = partText(message.content, "thinking");
	if (thinking) lines.push(`the agent was thinking: ${thinking}`);
	const text = partText(message.content, "text");
	if (text) {
		const label = role === "user" ? "user" : role === "toolResult" ? "tool result" : role === "assistant" ? "the agent said" : role;
		lines.push(`${label}: ${text}`);
	}
	lines.push(...toolCallLines(message.content));
	return lines;
}

/** The full situation: the status line, the last tool result, then the recent messages. */
export function renderState(lead: string, messages: LooseMessage[], lastToolResult?: string): string {
	const parts: string[] = [lead];
	if (lastToolResult) parts.push(`last tool result: ${lastToolResult}`);
	for (const message of messages) parts.push(...messageLines(message));
	return parts.join("\n");
}
