import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendMoodLog } from "./log.ts";
import { faceCriteria, INSTRUCTIONS, paletteEntries, pickFace, resetMoodHistory } from "./mood.ts";
import { clamp, type LooseMessage, MAX_ARGS, partText, renderState } from "./state.ts";

const DEBOUNCE_MS = 1_200;
const REFRESH_MS = 5_000;
const RECENT_MESSAGES = 8;

type Registry = ExtensionContext["modelRegistry"];
type ClassifierModel = Parameters<Registry["classify"]>[0];
type ClassifierChoice = { model: ClassifierModel; apiKey?: string };

/** Identifies the palette a sample was classified against. */
const paletteHash = createHash("sha1").update(JSON.stringify(faceCriteria)).digest("hex").slice(0, 12);

/**
 * pi-mood: a tiny mascot in the footer, chosen by a System One classifier (Jev)
 * through pi's own model registry. It is given the live session state — the
 * running tool, the agent's reasoning and tool calls, and the recent prompts —
 * and it picks one face. The extension adds no rules.
 */
export default function (pi: ExtensionAPI) {
	if (process.env.PI_MOOD_DISABLE === "1") return;

	let ctx: ExtensionContext | undefined;
	let lastToolResult = "";
	let phase: "idle" | "thinking" | "working" | "done" = "idle";
	let liveMessage: LooseMessage | undefined;
	let lastState = "";
	const runningTools = new Map<string, { name: string; args: string; startedAt: number }>();
	let classifier: ClassifierChoice | undefined;
	let classifierResolved = false;
	let paletteLogged = false;
	let inFlight = false;
	let queued = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const isTui = (source: ExtensionContext): boolean => source.mode === "tui" && typeof source.ui.setStatus === "function";
	const setFace = (face: string): void => {
		try {
			ctx?.ui.setStatus("pi-mood", face);
		} catch {
			// The UI may already be disposed.
		}
	};

	/** Any classifier the account can use, preferring a free Jev. Falls back to an opencode Jev with whichever opencode key is configured. */
	const resolveClassifier = async (source: ExtensionContext): Promise<ClassifierChoice | undefined> => {
		if (classifierResolved) return classifier;
		classifierResolved = true;
		try {
			const models = await source.modelRegistry.getAvailableOfType("classifier");
			const model = models.find((m) => m.id === "jev-1.13-free") ?? models.find((m) => /jev/i.test(m.id)) ?? models[0];
			if (model) return (classifier = { model });
			const fallback = source.modelRegistry.findOfType("classifier", "opencode", "jev-1.13-free");
			if (!fallback) return undefined;
			const apiKey =
				(await source.modelRegistry.getApiKeyForProvider("opencode")) ?? (await source.modelRegistry.getApiKeyForProvider("opencode-go"));
			return (classifier = apiKey ? { model: fallback, apiKey } : undefined);
		} catch {
			return undefined;
		}
	};

	/** Everything the classifier sees: the running tool, the recent reasoning and tool calls, and the prompts. */
	const buildState = (): string => {
		const tool = Array.from(runningTools.values())[0];
		const lead = tool
			? `the agent is in the middle of running the ${tool.name} tool (${tool.args}), the work is not done yet`
			: phase === "done"
				? "the agent just finished the work, the result looks good"
				: phase === "thinking"
					? "the agent is thinking about how to do the task, no tool has run yet"
					: "the agent is idle and waiting for the user";
		const messages = (ctx?.sessionManager.getEntries().filter((e) => e.type === "message").slice(-RECENT_MESSAGES) ?? [])
			.map((entry) => (entry as { message?: LooseMessage }).message)
			.filter((message): message is LooseMessage => message !== undefined);
		if (liveMessage) messages.push(liveMessage);
		return renderState(lead, messages, lastToolResult || undefined);
	};

	async function run(): Promise<void> {
		if (inFlight) {
			queued = true;
			return;
		}
		const source = ctx;
		if (!source) return;
		const state = buildState();
		if (state === lastState) return;
		inFlight = true;
		const startedAt = Date.now();
		try {
			const choice = await resolveClassifier(source);
			if (!choice) return;
			const result = await source.modelRegistry.classify(
				choice.model,
				{
					state: { situation: state },
					questions: { face: { type: "choice", instructions: INSTRUCTIONS, criteria: faceCriteria } },
				},
				choice.apiKey ? { apiKey: choice.apiKey } : undefined,
			);
			const base = {
				ts: new Date().toISOString(),
				session: source.sessionManager.getSessionId(),
				cwd: source.sessionManager.getCwd(),
				model: choice.model.id,
				provider: choice.model.provider,
				palette: paletteHash,
				state,
				latencyMs: Date.now() - startedAt,
			};
			if (result.stopReason !== "stop") {
				appendMoodLog({ ...base, type: "error", stopReason: result.stopReason, errorMessage: result.errorMessage });
				return;
			}
			const answer = result.answers.face;
			if (answer?.type !== "choice") return;
			lastState = state;
			const { face, scores } = pickFace(answer.probabilities);
			setFace(face);
			appendMoodLog({
				...base,
				type: "sample",
				choice: answer.choice,
				displayed: face,
				confidence: answer.confidence,
				probabilities: answer.probabilities,
				scores,
				usage: result.usage,
			});
		} catch (error) {
			appendMoodLog({ type: "error", ts: new Date().toISOString(), state, message: error instanceof Error ? error.message : String(error) });
		} finally {
			inFlight = false;
			if (queued) {
				queued = false;
				schedule();
			}
		}
	}

	function schedule(): void {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void run();
		}, DEBOUNCE_MS);
	}

	const activity = (source: ExtensionContext): void => {
		ctx = source;
	};

	pi.on("session_start", (_event, source) => {
		ctx = isTui(source) ? source : undefined;
		lastToolResult = "";
		phase = "idle";
		liveMessage = undefined;
		lastState = "";
		runningTools.clear();
		resetMoodHistory();
		if (!paletteLogged) {
			paletteLogged = true;
			appendMoodLog({ type: "palette", ts: new Date().toISOString(), hash: paletteHash, instructions: INSTRUCTIONS, criteria: faceCriteria, faces: paletteEntries });
		}
		if (interval) clearInterval(interval);
		interval = setInterval(() => void run(), REFRESH_MS);
		schedule();
	});

	pi.on("input", (_event, source) => {
		if (!isTui(source)) return;
		activity(source);
		phase = "thinking";
		schedule();
	});

	pi.on("agent_start", (_event, source) => {
		if (!isTui(source)) return;
		activity(source);
		phase = "thinking";
		liveMessage = undefined;
		schedule();
	});

	pi.on("message_update", (event, source) => {
		if (!isTui(source)) return;
		activity(source);
		if ("partial" in event.assistantMessageEvent) liveMessage = event.assistantMessageEvent.partial;
	});

	pi.on("tool_execution_start", (event, source) => {
		if (!isTui(source)) return;
		activity(source);
		phase = "working";
		runningTools.set(event.toolCallId, {
			name: event.toolName,
			args: clamp(JSON.stringify(event.args ?? {}), MAX_ARGS),
			startedAt: Date.now(),
		});
		schedule();
	});

	pi.on("tool_execution_end", (event, source) => {
		if (!isTui(source)) return;
		activity(source);
		runningTools.delete(event.toolCallId);
		if (runningTools.size === 0) phase = "thinking";
		const output = partText((event.result as { content?: unknown } | undefined)?.content, "text");
		lastToolResult = `${event.toolName} (error=${event.isError})${output ? ` ${output}` : ""}`;
		schedule();
	});

	pi.on("message_end", (event, source) => {
		if (!isTui(source) || event.message.role !== "assistant") return;
		activity(source);
		liveMessage = undefined;
		schedule();
	});

	pi.on("agent_settled", (_event, source) => {
		if (!isTui(source)) return;
		activity(source);
		phase = "done";
		schedule();
	});

	pi.on("session_shutdown", () => {
		if (timer) clearTimeout(timer);
		if (interval) clearInterval(interval);
		timer = undefined;
		interval = undefined;
		try {
			ctx?.ui.setStatus("pi-mood", undefined);
		} catch {
			// The UI may already be disposed.
		}
		ctx = undefined;
		runningTools.clear();
	});
}
