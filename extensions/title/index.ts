/**
 * Title: name each session from its first exchange with a small LLM call.
 *
 * The generated name is written with `setSessionName`, so it persists in the
 * session file and shows up in `/resume`, the terminal title, and any sidebar
 * reading session names. No side-channel cache.
 *
 * `/title`                 regenerate the title now
 * `/title set <text>`      set a title (use when it starts with a keyword)
 * `/title <text>`          set a title from free text
 * `/title model`           show the configured and session models
 * `/title model <ref>`     use `null`/`active`, `auto`, or `provider/model[:effort]`
 * `/title on|off`          enable/disable automatic titles
 * `/title config`          show the effective configuration
 *
 * Config file: `~/.pi/agent/title.json`. See config.ts. Module split:
 * config.ts (persistence), models.ts (model resolution), exchange.ts (prompting).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logTitleError, logPath, readConfig, configPath, writeConfig } from "./config.ts";
import { cleanTitle, clipExchange, describeResponse, firstExchange, neutralizeDelimiters, SYSTEM_PROMPT, textOf } from "./exchange.ts";
import {
	effortOptions,
	opencodeSessionHeaders,
	resolveModel,
	supportedThinkingLevel,
	THINKING_LEVELS,
	type CompleteOptions,
	type ThinkingLevel,
	type TitleRequest,
} from "./models.ts";

/** Wait this long after the first user message before auto-titling. */
const AUTO_TITLE_DELAY_MS = 60_000;

export default function (pi: ExtensionAPI) {
	const config = readConfig();
	let generating = false;
	/** One delayed auto-title timer per session, keyed by sessionKey. */
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const scheduled = new Set<string>();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "error" = "info") => ctx.ui.notify(message, level);

	const sessionKey = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();

	async function generate(ctx: ExtensionContext, force: boolean): Promise<string | undefined> {
		if (!force && pi.getSessionName()) return undefined;
		const { model, thinkingLevel } = resolveModel(ctx, config);
		const exchange = firstExchange(ctx.sessionManager.buildContextEntries());
		if (!exchange) throw new Error("nothing to title yet; send a message first");
		// The request/response halves are untrusted: clip them and strip our own
		// data tags so the model cannot be tricked into leaving the data section.
		const user = neutralizeDelimiters(clipExchange(exchange.user));
		const reply = exchange.assistant ? neutralizeDelimiters(clipExchange(exchange.assistant)) : "";
		const content = `<request>\n${user}\n</request>` + (reply ? `\n\n<response>\n${reply}\n</response>` : "");
		const request: TitleRequest = { systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] };
		const budget = thinkingLevel ? THINKING_LEVELS[thinkingLevel] : 0;
		const sessionId = ctx.sessionManager.getSessionId();
		const run = (maxTokens: number, reasoning?: ThinkingLevel) => {
			const options: CompleteOptions = {
				maxTokens,
				cacheRetention: "none",
				sessionId,
				// Ours win over incoming so the opencode session header is not dropped.
				transformHeaders: (headers: Record<string, string | null>) => ({ ...headers, ...opencodeSessionHeaders(model, sessionId) }),
				...effortOptions(model, reasoning),
			};
			return ctx.modelRegistry.complete(model, request, options);
		};

		let maxTokens = config.maxTokens + budget;
		let response = await run(maxTokens, thinkingLevel);
		let title = cleanTitle(textOf(response.content), config.maxLength);
		if (!title && response.stopReason === "length") {
			// Reasoning tokens can use the whole budget before any visible text appears; retry with more headroom.
			maxTokens = config.maxTokens + Math.max(budget, 1024);
			const fallback: ThinkingLevel | undefined = model.reasoning ? supportedThinkingLevel(model, "minimal") : thinkingLevel;
			response = await run(maxTokens, fallback);
			title = cleanTitle(textOf(response.content), config.maxLength);
		}
		if (!title) throw new Error(`no usable title text: ${describeResponse(model, response, maxTokens)}`);
		pi.setSessionName(title);
		return title;
	}

	/** Runs after the delay; bails if the session changed, was named, or is busy. */
	const attempt = async (ctx: ExtensionContext, key: string): Promise<void> => {
		timers.delete(key);
		scheduled.delete(key);
		if (!config.enabled || pi.getSessionName()) return;
		if (sessionKey(ctx) !== key) return; // switched sessions since scheduling
		// Busy or already generating: re-arm rather than dropping the title forever.
		if (generating || !ctx.isIdle()) {
			timers.set(
				key,
				setTimeout(() => void attempt(ctx, key), generating ? 5_000 : 15_000),
			);
			timers.get(key)?.unref?.();
			return;
		}
		generating = true;
		try {
			const title = await generate(ctx, false);
			if (title) notify(ctx, `Session titled: ${title}`);
		} catch (error) {
			logTitleError(`auto: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			generating = false;
		}
	};

	/** Schedule one delayed auto-title per session, a minute after its first message. */
	const schedule = (ctx: ExtensionContext): void => {
		if (!config.enabled || pi.getSessionName()) return;
		const key = sessionKey(ctx);
		if (scheduled.has(key) || timers.has(key)) return;
		scheduled.add(key);
		timers.set(
			key,
			setTimeout(() => void attempt(ctx, key), AUTO_TITLE_DELAY_MS),
		);
		timers.get(key)?.unref?.();
	};

	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") schedule(ctx);
	});

	// Reloaded/resumed sessions with history but no name still get titled.
	pi.on("session_start", (_event, ctx) => {
		const hasUserMessage = ctx.sessionManager
			.buildContextEntries()
			.some((entry) => entry.type === "message" && entry.message.role === "user");
		if (hasUserMessage) schedule(ctx);
	});

	pi.on("session_shutdown", () => {
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		scheduled.clear();
	});

	pi.registerCommand("title", {
		description: "Generate, set, or configure the session title",
		handler: async (args, ctx) => {
			const input = args.trim();
			const [head, ...rest] = input.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!input) {
				try {
					notify(ctx, `Title: ${await generate(ctx, true)}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					logTitleError(`manual: ${message}`);
					notify(ctx, `${message}\n(logged to ${logPath})`, "error");
				}
				return;
			}
			if (head === "set") {
				if (!tail) {
					notify(ctx, "Usage: /title set <text>", "error");
					return;
				}
				pi.setSessionName(tail);
				notify(ctx, `Title set: ${tail}`);
				return;
			}
			if (head === "model") {
				if (!tail) {
					notify(ctx, `Title model: ${config.model ?? "active (session model)"} · session: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`);
					return;
				}
				const value = tail === "active" || tail === "null" ? null : tail;
				if (value && value !== "auto") {
					// Resolve before persisting so a typo is rejected here, not at title time.
					try {
						resolveModel(ctx, { model: value });
					} catch (error) {
						notify(ctx, error instanceof Error ? error.message : String(error), "error");
						return;
					}
				}
				config.model = value;
				if (!writeConfig(config)) {
					notify(ctx, `Could not write ${configPath} (logged to ${logPath})`, "error");
					return;
				}
				notify(ctx, `Title model: ${value ?? "active (session model)"}`);
				return;
			}
			if (head === "on" || head === "off") {
				config.enabled = head === "on";
				if (!writeConfig(config)) {
					notify(ctx, `Could not write ${configPath} (logged to ${logPath})`, "error");
					return;
				}
				notify(ctx, `Automatic titles ${config.enabled ? "enabled" : "disabled"}`);
				return;
			}
			if (head === "config") {
				notify(ctx, `${configPath} · ${JSON.stringify(config)} (read at session start)`);
				return;
			}
			pi.setSessionName(input);
			notify(ctx, `Title set: ${input}`);
		},
	});
}
