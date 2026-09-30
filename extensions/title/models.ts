/**
 * Model resolution for title generation: pick a (small) model from config
 * (`null` = active session model, `"auto"` = cheapest configured candidate) or
 * a `provider/model[:effort]` reference, plus the opencode session-header fix.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TitleModel = NonNullable<ExtensionContext["model"]>;
export type TitleRequest = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
export type TitleResponse = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
export type CompleteOptions = NonNullable<Parameters<ExtensionContext["modelRegistry"]["complete"]>[2]>;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Token budget per thinking level used when sizing the completion. */
export const THINKING_LEVELS: Record<ThinkingLevel, number> = {
	off: 0,
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 16384,
	max: 32768,
};

/** Cheap models tried in order when `model` is `"auto"`. */
const AUTO_MODELS = [
	"openai/gpt-5-nano",
	"openrouter/openai/gpt-5-nano",
	"google/gemini-2.5-flash-lite",
	"openrouter/google/gemini-2.5-flash-lite",
	"anthropic/claude-haiku-4-5",
];

function splitReference(
	reference: string,
): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return undefined;
	const provider = reference.slice(0, slash);
	const rest = reference.slice(slash + 1);
	const colon = rest.lastIndexOf(":");
	const level = colon > 0 ? (rest.slice(colon + 1) as ThinkingLevel) : undefined;
	if (level && Object.hasOwn(THINKING_LEVELS, level)) return { provider, modelId: rest.slice(0, colon), thinkingLevel: level };
	return { provider, modelId: rest };
}

function findModel(ctx: Pick<ExtensionContext, "modelRegistry">, provider: string, modelId: string): TitleModel | undefined {
	const exact = ctx.modelRegistry.find(provider, modelId);
	if (exact) return exact;
	const matches = ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.provider.toLowerCase() === provider.toLowerCase() && model.id.toLowerCase().includes(modelId.toLowerCase()));
	if (matches.length === 0) return undefined;
	const aliases = matches.filter((model) => !/-\d{8}$/.test(model.id));
	const pool = aliases.length > 0 ? aliases : matches;
	// Prefer an authenticated match, then the shortest id; day-stamped variants sort last.
	const authed = pool.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	const candidates = authed.length > 0 ? authed : pool;
	return candidates.sort((a, b) => a.id.length - b.id.length || b.id.localeCompare(a.id))[0];
}

/**
 * `modelRegistry.complete()` forwards options straight to the provider adapter,
 * which reads a different key per API (`reasoningEffort`, `thinkingEnabled`, or
 * `reasoning`). `StreamOptions` has no `reasoning`, so passing that alone is
 * silently ignored for the OpenAI-compatible, Anthropic and Mistral adapters.
 */
export function effortOptions(model: TitleModel, level: ThinkingLevel | undefined): CompleteOptions {
	if (!level) return {};
	switch (model.api) {
		case "anthropic-messages":
			return { thinkingEnabled: level !== "off" };
		case "bedrock-converse-stream":
		case "pi-messages":
			return { reasoning: level };
		default:
			return { reasoningEffort: level === "off" ? undefined : level };
	}
}

/** Map a level through the model's `thinkingLevelMap`, matching adapter behavior. */
export function supportedThinkingLevel(model: TitleModel, level: ThinkingLevel): ThinkingLevel {
	return model.thinkingLevelMap?.[level] === null ? "off" : level;
}

export function resolveModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	config: { model: string | null },
): { model: TitleModel; thinkingLevel?: ThinkingLevel } {
	if (!config.model) {
		if (!ctx.model) throw new Error("no active model: set one or configure /title model");
		return { model: ctx.model };
	}
	if (config.model === "auto") {
		for (const reference of AUTO_MODELS) {
			const parsed = splitReference(reference);
			if (!parsed) continue;
			const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
			if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { model };
		}
		throw new Error("no configured model from the auto list is available");
	}
	const parsed = splitReference(config.model);
	if (!parsed) throw new Error(`invalid model reference: ${config.model}`);
	const model = findModel(ctx, parsed.provider, parsed.modelId);
	if (!model) throw new Error(`model is unavailable: ${config.model}`);
	if (parsed.thinkingLevel && model.thinkingLevelMap?.[parsed.thinkingLevel] === null) {
		throw new Error(`thinking level ${parsed.thinkingLevel} is unsupported by ${model.provider}/${model.id}`);
	}
	return { model, thinkingLevel: parsed.thinkingLevel };
}

/**
 * opencode providers reject requests without an `x-opencode-session` header.
 * pi's agent loop injects it (see provider-attribution), but direct
 * `modelRegistry.complete()` calls bypass that, so add it here.
 */
export function opencodeSessionHeaders(model: TitleModel, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	let opencode = model.provider === "opencode" || model.provider === "opencode-go";
	if (!opencode) {
		try {
			opencode = new URL(model.baseUrl).hostname === "opencode.ai";
		} catch {
			opencode = false;
		}
	}
	return opencode ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : undefined;
}
