import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type PgStore, PgStore as PgStoreClass, pgErrorText, trackerConnectionString } from "./store.ts";

/** Cap each string so oversized payloads stay queryable in Postgres. */
const MAX_STRING_LENGTH = 20_000;

/** Structural event shapes. Kept local so the extension only depends on exported types. */
interface SessionStartLike {
	reason: string;
	previousSessionFile?: string;
}
interface SessionShutdownLike {
	reason: string;
	targetSessionFile?: string;
}
interface MessageLike {
	message: unknown;
}
interface ToolStartLike {
	toolCallId: string;
	toolName: string;
	args?: unknown;
}
interface ToolEndLike {
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError: boolean;
}
interface AgentEndLike {
	messages: unknown[];
}
interface ProviderResponseLike {
	status: number;
	headers: Record<string, string>;
}
interface ProviderRequestLike {
	payload: unknown;
}
interface ModelSelectLike {
	model: { provider?: string; id?: string };
	previousModel?: { provider?: string; id?: string };
	source?: string;
}
interface ThinkingLevelLike {
	level: string;
	previousLevel?: string;
}
interface InputLike {
	text: string;
	source: string;
	images?: unknown[];
	streamingBehavior?: string;
}
interface UserBashLike {
	command: string;
	excludeFromContext: boolean;
	cwd: string;
}

interface StreamState {
	startedAt: Date;
	chunks: number;
	firstChunkAt: Date | null;
}

interface TurnState {
	id: string;
	startedAt: Date;
	toolCount: number;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface AssistantInfo {
	provider: string | null;
	model: string | null;
	stopReason: string | null;
	timestamp: number | null;
	errorMessage: string | null;
	usage: UsageTotals | null;
}

function field<T>(value: unknown, key: string): T | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return (value as Record<string, unknown>)[key] as T | undefined;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeDate(value: string | number | undefined): Date {
	const date = value === undefined ? new Date() : new Date(value);
	return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isTextContent(item: unknown): item is { text: string } {
	return typeof item === "object" && item !== null && "text" in item && typeof item.text === "string";
}

/** Recursively strip image/base64 blobs and cap long strings so payloads stay queryable in PG. */
function sanitize(
	value: unknown,
	maxStringLength = Number.POSITIVE_INFINITY,
	ancestors = new WeakSet<object>(),
	depth = 0,
): unknown {
	if (typeof value === "string" && value.length > maxStringLength) return value.slice(0, maxStringLength);
	if (typeof value !== "object" || value === null) return value;
	if (ancestors.has(value)) return "[Circular]";
	if (depth >= 100) return "[MaxDepth]";
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => sanitize(item, maxStringLength, ancestors, depth + 1));
		const record = value as Record<string, unknown>;
		if (record.type === "image") {
			const { data: _data, base64: _base64, ...rest } = record;
			return sanitize(rest, maxStringLength, ancestors, depth + 1);
		}
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(record)) out[key] = sanitize(item, maxStringLength, ancestors, depth + 1);
		return out;
	} finally {
		ancestors.delete(value);
	}
}

function normalizeUsage(value: unknown): UsageTotals | null {
	if (typeof value !== "object" || value === null) return null;
	const cost = typeof (value as Record<string, unknown>).cost === "object" && (value as Record<string, unknown>).cost !== null
		? ((value as Record<string, unknown>).cost as Record<string, unknown>)
		: {};
	const u = value as Record<string, unknown>;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		totalTokens: num(u.totalTokens ?? num(u.input) + num(u.output)),
		cost: {
			input: num(cost.input),
			output: num(cost.output),
			cacheRead: num(cost.cacheRead),
			cacheWrite: num(cost.cacheWrite),
			total: num(cost.total),
		},
	};
}

function assistantInfo(message: unknown): AssistantInfo {
	if (field<string>(message, "role") !== "assistant") {
		return { provider: null, model: null, stopReason: null, timestamp: null, errorMessage: null, usage: null };
	}
	return {
		provider: field<string>(message, "provider") ?? null,
		model: field<string>(message, "model") ?? null,
		stopReason: field<string>(message, "stopReason") ?? null,
		timestamp: field<number>(message, "timestamp") ?? null,
		errorMessage: field<string>(message, "errorMessage") ?? null,
		usage: normalizeUsage(field(message, "usage")),
	};
}

function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function sumUsage(messages: unknown[]): UsageTotals {
	const total = emptyUsage();
	for (const message of messages) {
		const usage = assistantInfo(message).usage;
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

function entryRole(entry: SessionEntry): string | null {
	if (entry.type !== "message") return null;
	const role = field<string>((entry as { message?: unknown }).message, "role");
	return typeof role === "string" ? role : null;
}

function entryPayload(entry: SessionEntry): unknown {
	const { id: _id, parentId: _parentId, timestamp: _timestamp, type: _type, ...rest } = entry as unknown as Record<string, unknown>;
	return sanitize(rest, MAX_STRING_LENGTH);
}

const SHELL_TOOLS = new Set(["bash", "powershell"]);

/** pi's shell tools expose no exit code; a clean return means the process exited 0. */
function shellSuccessExit(toolName: string): number | null {
	return SHELL_TOOLS.has(toolName) ? 0 : null;
}

function detailExitCode(details: unknown): number | null {
	if (typeof details !== "object" || details === null || !("exitCode" in details)) return null;
	const exitCode = (details as { exitCode?: unknown }).exitCode;
	return typeof exitCode === "number" ? exitCode : null;
}

function parseExitCode(text: string | null): number | null {
	const match = text === null ? null : /exited with code (\d+)/i.exec(text);
	return match?.[1] === undefined ? null : Number(match[1]);
}

const CONNECTION_ERROR_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"EAI_AGAIN",
]);

/** True for socket/SQLSTATE failures where a reconnect may succeed. */
function isConnectionError(error: unknown): boolean {
	const code = field<string>(error, "code");
	if (typeof code === "string" && (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08") || code.startsWith("57P"))) {
		return true;
	}
	const message = field<string>(error, "message");
	return typeof message === "string" && /connection terminated|connection closed|client has already been closed|not connected|timeout exceeded/i.test(message);
}

const RESPONSE_HEADER_ALLOWLIST = new Set(["content-type", "x-request-id"]);

/** Keep only benign response headers; provider headers can carry credentials. */
function allowedResponseHeaders(headers: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		if (RESPONSE_HEADER_ALLOWLIST.has(lower) || lower.includes("ratelimit") || lower.includes("rate-limit")) {
			out[name] = value;
		}
	}
	return out;
}

function toolResultInfo(
	toolName: string,
	isError: boolean,
	result: unknown,
): { output: string | null; details: unknown; exitCode: number | null } {
	const fallback = isError ? null : shellSuccessExit(toolName);
	if (typeof result !== "object" || result === null) return { output: null, details: null, exitCode: fallback };
	const details = "details" in result ? (result as { details?: unknown }).details : null;
	const content = "content" in result ? (result as { content?: unknown }).content : null;
	const output = Array.isArray(content) ? content.filter(isTextContent).map((item) => item.text).join("\n") : null;
	return { output, details, exitCode: detailExitCode(details) ?? parseExitCode(output) ?? fallback };
}

function disabled(): boolean {
	const value = process.env.PI_TRACKER_DISABLE;
	return value === "1" || value === "true" || value === "yes";
}

function storePayloads(): boolean {
	const value = process.env.PI_TRACKER_PAYLOADS;
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Maps pi editor extension events onto the pi_tracker schema.
 *
 * Writes are fire-and-forget: the tracker queues them against a single pg client
 * and reports any failure through `onError` without ever breaking the agent.
 */
export class Tracker {
	readonly onError: (error: unknown) => void;

	private ready: Promise<PgStore | null> = Promise.resolve(null);
	private pending: Promise<void> = Promise.resolve();
	private sessionId = "";
	private projectId = "";
	private readonly seenEntries = new Set<string>();
	private currentStream: StreamState | null = null;
	private currentTurn: TurnState | null = null;
	private turnSeq = 0;
	private toolStarts = new Map<string, { startedAt: Date; name: string; args: unknown }>();
	private ctx: ExtensionContext | null = null;
	private stopping = false;
	private reconnectLoop: Promise<PgStore | null> | null = null;
	private wakeReconnect: (() => void) | null = null;

	constructor(onError: (error: unknown) => void = (error) => console.error("[pi-pg-export]", pgErrorText(error))) {
		this.onError = onError;
	}

	private report = (error: unknown): void => {
		this.onError(error);
	};

	private handleError = (error: unknown): void => {
		this.report(error);
		if (isConnectionError(error)) this.scheduleReconnect();
	};

	private enqueue(work: (store: PgStore) => Promise<void>): void {
		this.pending = this.pending
			.then(() => this.ready)
			.then((store) => (store ? work(store) : undefined))
			.catch(this.handleError);
	}

	start(event: SessionStartLike, ctx: ExtensionContext): void {
		this.sessionId = "";
		this.projectId = "";
		this.seenEntries.clear();
		this.currentStream = null;
		this.currentTurn = null;
		this.turnSeq = 0;
		this.toolStarts.clear();
		this.ctx = ctx;
		this.stopping = false;
		this.reconnectLoop = null;
		this.wakeReconnect = null;
		this.pending = Promise.resolve();
		this.ready = disabled() ? Promise.resolve(null) : this.bootstrap(event, ctx);
	}

	private async bootstrap(event: SessionStartLike, ctx: ExtensionContext): Promise<PgStore | null> {
		let store: PgStore | null = null;
		try {
			store = await this.connectAndUpsert(ctx);
			if (!store) return null;
			this.turnSeq = await store.maxTurnSeq(this.sessionId);
			await store.insertEvent({
				sessionId: this.sessionId,
				name: "session_start",
				attributes: { reason: event.reason, previousSessionFile: event.previousSessionFile ?? null },
				occurredAt: new Date(),
			});
			// Backfill any entries already present (e.g. resumed sessions).
			for (const [index, entry] of ctx.sessionManager.getEntries().entries()) {
				if (this.seenEntries.has(entry.id)) continue;
				this.seenEntries.add(entry.id);
				await store.insertEntry({
					sessionId: this.sessionId,
					entryId: entry.id,
					parentId: entry.parentId,
					seq: index,
					type: entry.type,
					role: entryRole(entry),
					occurredAt: safeDate(entry.timestamp),
					payload: entryPayload(entry),
				});
			}
			return store;
		} catch (error) {
			if (store) await store.close().catch(() => undefined);
			this.report(error);
			if (isConnectionError(error)) this.scheduleReconnect();
			return null;
		}
	}

	private async connectAndUpsert(ctx: ExtensionContext): Promise<PgStore | null> {
		const connectionString = trackerConnectionString();
		if (!connectionString) return null;
		const store = await PgStoreClass.connect(connectionString);
		try {
			const cwd = ctx.cwd;
			const slug = process.env.PI_TRACKER_PROJECT ?? (basename(cwd) || "unknown");
			this.projectId = await store.upsertProject(slug, cwd);
			this.sessionId = await store.upsertSession({
				id: ctx.sessionManager.getSessionId(),
				fallbackId: randomUUID(),
				projectId: this.projectId,
				name: ctx.sessionManager.getSessionName(),
				cwd,
				file: ctx.sessionManager.getSessionFile(),
				mode: ctx.mode,
			});
			return store;
		} catch (error) {
			await store.close().catch(() => undefined);
			throw error;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectLoop || this.stopping || disabled()) return;
		console.error("[pi-pg-export] export degraded: database unavailable, retrying with backoff");
		const loop = this.reconnectWithBackoff();
		this.reconnectLoop = loop;
		this.ready = loop;
	}

	private async reconnectWithBackoff(): Promise<PgStore | null> {
		let delay = 1_000;
		while (!this.stopping) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				this.wakeReconnect = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.wakeReconnect = null;
			if (this.stopping) return null;
			delay = Math.min(delay * 2, 60_000);
			const ctx = this.ctx;
			if (!ctx) return null;
			try {
				const store = await this.connectAndUpsert(ctx);
				if (store) {
					this.reconnectLoop = null;
					console.error("[pi-pg-export] export recovered");
					return store;
				}
				return null;
			} catch (error) {
				this.onError(error);
			}
		}
		return null;
	}

	async stop(event: SessionShutdownLike, ctx: ExtensionContext): Promise<void> {
		this.stopping = true;
		this.wakeReconnect?.();
		this.syncEntries(ctx);
		this.record("session_shutdown", { reason: event.reason, targetSessionFile: event.targetSessionFile ?? null }, ctx);
		if (this.sessionId) this.enqueue((store) => store.setSessionStatus(this.sessionId, "ended"));
		try {
			await this.pending;
		} catch {
			// reported already
		}
		const store = await this.ready;
		await store?.close();
		this.ready = Promise.resolve(null);
	}

	/** Pi writes session entries without emitting events, so poll for new ones at turn boundaries. */
	syncEntries(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		entries.forEach((entry, index) => {
			if (this.seenEntries.has(entry.id)) return;
			this.enqueue(async (store) => {
				await store.insertEntry({
					sessionId: this.sessionId,
					entryId: entry.id,
					parentId: entry.parentId,
					seq: index,
					type: entry.type,
					role: entryRole(entry),
					occurredAt: safeDate(entry.timestamp),
					payload: entryPayload(entry),
				});
				this.seenEntries.add(entry.id);
			});
		});
	}

	turnStart(_event: unknown, _ctx: ExtensionContext): void {
		this.currentTurn = { id: randomUUID(), startedAt: new Date(), toolCount: 0 };
	}

	messageStart(event: MessageLike, _ctx: ExtensionContext): void {
		if (field<string>(event.message, "role") !== "assistant") return;
		this.currentStream = { startedAt: new Date(), chunks: 0, firstChunkAt: null };
	}

	messageUpdate(event: MessageLike, _ctx: ExtensionContext): void {
		if (field<string>(event.message, "role") !== "assistant") return;
		if (!this.currentStream) return;
		this.currentStream.chunks += 1;
		this.currentStream.firstChunkAt ??= new Date();
	}

	messageEnd(event: MessageLike, _ctx: ExtensionContext): void {
		const message = event.message;
		if (field<string>(message, "role") !== "assistant") return;
		const stream = this.currentStream;
		this.currentStream = null;
		const turnId = this.currentTurn?.id ?? null;
		const info = assistantInfo(message);
		const startedAt = stream?.startedAt ?? (info.timestamp ? new Date(info.timestamp) : new Date());
		const endedAt = new Date();
		this.enqueue((store) =>
			store.insertLlmCall({
				id: randomUUID(),
				sessionId: this.sessionId,
				turnId,
				provider: info.provider ?? "unknown",
				model: info.model ?? "unknown",
				streamed: stream !== undefined,
				stopReason: info.stopReason,
				usage: info.usage ?? {},
				tokensIn: info.usage?.input ?? null,
				tokensOut: info.usage?.output ?? null,
				cacheRead: info.usage?.cacheRead ?? null,
				cacheWrite: info.usage?.cacheWrite ?? null,
				cost: info.usage?.cost.total ?? null,
				durationMs: endedAt.getTime() - startedAt.getTime(),
				ttftMs: stream?.firstChunkAt ? stream.firstChunkAt.getTime() - startedAt.getTime() : null,
				chunkCount: stream?.chunks ?? null,
				error: info.errorMessage ? { message: info.errorMessage } : null,
				startedAt,
				endedAt,
			}),
		);
	}

	toolStart(event: ToolStartLike, _ctx: ExtensionContext): void {
		this.toolStarts.set(event.toolCallId, {
			startedAt: new Date(),
			name: event.toolName,
			args: sanitize(event.args, MAX_STRING_LENGTH),
		});
	}

	toolEnd(event: ToolEndLike, _ctx: ExtensionContext): void {
		const started = this.toolStarts.get(event.toolCallId);
		this.toolStarts.delete(event.toolCallId);
		if (this.currentTurn) this.currentTurn.toolCount += 1;
		const turnId = this.currentTurn?.id ?? null;
		const startedAt = started?.startedAt ?? new Date();
		const endedAt = new Date();
		const result = toolResultInfo(event.toolName, event.isError, event.result);
		const output = sanitize(result.output, MAX_STRING_LENGTH) as string | null;
		const details = sanitize(result.details, MAX_STRING_LENGTH);
		this.enqueue((store) =>
			store.insertToolCall({
				id: randomUUID(),
				sessionId: this.sessionId,
				turnId,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: started?.args ?? null,
				output,
				outputJson: details,
				isError: event.isError,
				error: event.isError ? (details ?? output) : null,
				exitCode: result.exitCode,
				durationMs: endedAt.getTime() - startedAt.getTime(),
				details,
				startedAt,
				endedAt,
			}),
		);
	}

	turnEnd(event: { message?: unknown }, ctx: ExtensionContext): void {
		const turn = this.currentTurn;
		this.currentTurn = null;
		if (turn) {
			const info = assistantInfo(event.message);
			const status = info.stopReason === "aborted" ? "aborted" : info.stopReason === "error" ? "error" : "ok";
			this.enqueue((store) =>
				store.insertTurn({
					id: turn.id,
					sessionId: this.sessionId,
					seq: ++this.turnSeq,
					status,
					usage: info.usage ?? {},
					llmCount: info.usage ? 1 : 0,
					toolCount: turn.toolCount,
					startedAt: turn.startedAt,
					endedAt: new Date(),
				}),
			);
		}
		this.syncEntries(ctx);
	}

	agentEnd(event: AgentEndLike, ctx: ExtensionContext): void {
		this.syncEntries(ctx);
		this.record("agent_end", { messageCount: event.messages.length }, ctx);
	}

	agentSettled(_event: unknown, ctx: ExtensionContext): void {
		this.syncEntries(ctx);
		const usage = sumUsage(
			ctx.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) => (entry as { message?: unknown }).message),
		);
		const messageCount = ctx.sessionManager.getEntries().filter((entry) => entry.type === "message").length;
		this.enqueue((store) => store.updateSessionTotals(this.sessionId, messageCount, usage, "active"));
	}

	providerResponse(event: ProviderResponseLike, ctx: ExtensionContext): void {
		this.record("provider_response", { status: event.status, headers: allowedResponseHeaders(event.headers) }, ctx);
	}

	providerRequest(event: ProviderRequestLike, ctx: ExtensionContext): void {
		if (!storePayloads()) return;
		this.record("provider_request", { payload: sanitize(event.payload, MAX_STRING_LENGTH) }, ctx);
	}

	modelSelect(event: ModelSelectLike, ctx: ExtensionContext): void {
		const label = (model?: { provider?: string; id?: string }) => (model ? `${model.provider ?? "?"}/${model.id ?? "?"}` : null);
		this.record(
			"model_select",
			{ model: label(event.model), previousModel: label(event.previousModel), source: event.source ?? null },
			ctx,
		);
	}

	thinkingLevel(event: ThinkingLevelLike, ctx: ExtensionContext): void {
		this.record("thinking_level_select", { level: event.level, previousLevel: event.previousLevel ?? null }, ctx);
	}

	input(event: InputLike, ctx: ExtensionContext): void {
		this.record(
			"input",
			{ source: event.source, text: event.text, images: event.images?.length ?? 0, streamingBehavior: event.streamingBehavior ?? null },
			ctx,
		);
	}

	userBash(event: UserBashLike, ctx: ExtensionContext): void {
		this.record(
			"user_bash",
			{ command: event.command, excludeFromContext: event.excludeFromContext, cwd: event.cwd },
			ctx,
		);
	}

	sessionInfoChanged(event: { name: string | undefined }, _ctx: ExtensionContext): void {
		this.enqueue((store) => store.upsertSessionName(this.sessionId, event.name));
	}

	private record(name: string, attributes: Record<string, unknown>, _ctx: ExtensionContext): void {
		this.enqueue((store) =>
			store.insertEvent({ sessionId: this.sessionId, name, attributes: sanitize(attributes, MAX_STRING_LENGTH), occurredAt: new Date() }),
		);
	}
}
