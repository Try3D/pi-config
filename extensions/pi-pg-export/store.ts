import pg from "pg";

const { Client } = pg;

let warnedMissingConnection = false;

/** Export is opt-in: without an explicit URL the tracker stays disabled. */
export function trackerConnectionString(): string | null {
	const url = process.env.PI_TRACKER_DATABASE_URL;
	if (!url) {
		if (!warnedMissingConnection) {
			warnedMissingConnection = true;
			console.error("[pi-pg-export] PI_TRACKER_DATABASE_URL is not set; export disabled");
		}
		return null;
	}
	return url;
}

/** Postgres text/jsonb reject NUL (0x00); drop it from a string. */
function stripNulText(text: string): string {
	return text.replaceAll("\u0000", "");
}

/** Deep-copy `value` with NUL removed from every string and key, so the JSON stays valid. */
function stripNul(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return stripNulText(value);
	if (depth >= 100) return "[MaxDepth]";
	if (Array.isArray(value)) return value.map((item) => stripNul(item, depth + 1));
	if (typeof value === "object" && value !== null) {
		if (value instanceof Date || value instanceof Error) return value;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[stripNulText(key)] = stripNul(item, depth + 1);
		return out;
	}
	return value;
}

/** Serialize a jsonb parameter after removing NUL bytes Postgres refuses to parse. */
function jsonb(value: unknown): string {
	return JSON.stringify(stripNul(value ?? null));
}

export interface SessionUpsert {
	id: string;
	fallbackId: string;
	projectId: string;
	name: string | undefined;
	cwd: string;
	file: string | undefined;
	mode: string;
}

export interface EntryInsert {
	sessionId: string;
	entryId: string;
	parentId: string | null;
	seq: number;
	type: string;
	role: string | null;
	occurredAt: Date;
	payload: unknown;
}

export interface LlmCallInsert {
	id: string;
	sessionId: string;
	turnId: string | null;
	provider: string;
	model: string;
	streamed: boolean;
	stopReason: string | null;
	usage: unknown;
	tokensIn: number | null;
	tokensOut: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	cost: number | null;
	durationMs: number;
	ttftMs: number | null;
	chunkCount: number | null;
	error: unknown;
	startedAt: Date;
	endedAt: Date;
}

export interface ToolCallInsert {
	id: string;
	sessionId: string;
	turnId: string | null;
	toolCallId: string;
	toolName: string;
	args: unknown;
	output: string | null;
	outputJson: unknown;
	isError: boolean;
	error: unknown;
	exitCode: number | null;
	durationMs: number;
	details: unknown;
	startedAt: Date;
	endedAt: Date;
}

export interface TurnInsert {
	id: string;
	sessionId: string;
	seq: number;
	status: "ok" | "error" | "aborted";
	usage: unknown;
	llmCount: number;
	toolCount: number;
	startedAt: Date;
	endedAt: Date;
}

export interface EventInsert {
	sessionId: string;
	name: string;
	attributes: unknown;
	occurredAt: Date;
}

/** Postgres/Node error text, keeping the raw error object out of logs. */
export function pgErrorText(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const code = (error as { code?: unknown }).code;
	const message = (error as { message?: unknown }).message;
	const parts: string[] = [];
	if (typeof code === "string") parts.push(code);
	if (typeof message === "string") parts.push(message);
	return parts.length > 0 ? parts.join(": ") : "unknown error";
}

/**
 * Serialized writes onto one pg Client. A Client rejects concurrent queries, and
 * an audit timeline needs ordering, so every write is queued.
 */
export class PgStore {
	private queue: Promise<void> = Promise.resolve();
	private readonly client: InstanceType<typeof Client>;
	private unusable = false;
	private closed = false;

	private constructor(client: InstanceType<typeof Client>) {
		this.client = client;
	}

	static async connect(connectionString: string): Promise<PgStore> {
		// Refuse to ship an audit trail in plaintext to a remote host.
		try {
			const url = new URL(connectionString);
			const host = url.hostname;
			const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
			if (!local && url.searchParams.get("sslmode") !== "require") {
				throw new Error(`refusing non-local host "${host}" without sslmode=require`);
			}
		} catch (error) {
			// Re-throw the TLS guard; ignore URL parse failures (e.g. keyword/value form).
			if (!(error instanceof TypeError)) throw error;
		}
		// Cap connect and query waits so an unresponsive database cannot hang pi shutdown.
		const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
		const store = new PgStore(client);
		// An idle-client failure arrives as an 'error' event; without a listener Node
		// throws it and kills pi, so log once and mark the client unusable instead.
		client.on("error", (error) => {
			if (store.unusable || store.closed) return;
			store.unusable = true;
			console.error("[pi-pg-export] database connection error:", pgErrorText(error));
		});
		await client.connect();
		return store;
	}

	private run<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("PgStore is closed"));
		if (this.unusable) return Promise.reject(new Error("PgStore is unusable"));
		const next = this.queue.then(work, work);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	async upsertProject(slug: string, name: string | undefined): Promise<string> {
		return this.run(async () => {
			const result = await this.client.query<{ id: string }>(
				`insert into pi_tracker.projects (slug, name) values ($1, $2)
				 on conflict (slug) do update set name = coalesce(excluded.name, pi_tracker.projects.name)
				 returning id`,
				[slug, name ?? null],
			);
			const row = result.rows[0];
			if (!row) throw new Error("project upsert returned no row");
			return row.id;
		});
	}

	async upsertSession(row: SessionUpsert): Promise<string> {
		return this.run(async () => {
			// pi session ids are uuids, but fall back if a non-uuid id ever appears (22P02).
			for (const id of [row.id, row.fallbackId]) {
				try {
					await this.client.query(
						`insert into pi_tracker.sessions (id, project_id, name, cwd, file, mode, status, started_at, last_active_at)
						 values ($1, $2, $3, $4, $5, $6, 'active', now(), now())
						 on conflict (id) do update set
							name = coalesce(excluded.name, pi_tracker.sessions.name),
							cwd = coalesce(excluded.cwd, pi_tracker.sessions.cwd),
							file = coalesce(excluded.file, pi_tracker.sessions.file),
							mode = coalesce(excluded.mode, pi_tracker.sessions.mode),
							status = 'active',
							last_active_at = now()`,
						[id, row.projectId, row.name ?? null, row.cwd, row.file ?? null, row.mode],
					);
					return id;
				} catch (error) {
					const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
					if (code !== "22P02") throw error;
				}
			}
			throw new Error("could not upsert session row");
		});
	}

	async updateSessionTotals(id: string, messageCount: number, usage: unknown, status: "active" | "ended" | "aborted"): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`update pi_tracker.sessions
				 set message_count = $2, usage = $3::jsonb, status = $4, last_active_at = now()
				 where id = $1`,
				[id, messageCount, jsonb(usage ?? {}), status],
			);
		});
	}

	async upsertSessionName(id: string, name: string | undefined): Promise<void> {
		return this.run(async () => {
			await this.client.query(`update pi_tracker.sessions set name = $2, last_active_at = now() where id = $1`, [id, name ?? null]);
		});
	}

	async setSessionStatus(id: string, status: "active" | "ended" | "aborted"): Promise<void> {
		return this.run(async () => {
			await this.client.query(`update pi_tracker.sessions set status = $2, last_active_at = now() where id = $1`, [id, status]);
		});
	}

	async maxTurnSeq(sessionId: string): Promise<number> {
		return this.run(async () => {
			const result = await this.client.query<{ max: string | null }>(
				`select max(seq)::text as max from pi_tracker.turns where session_id = $1`,
				[sessionId],
			);
			return result.rows[0]?.max === null || result.rows[0]?.max === undefined ? 0 : Number(result.rows[0].max);
		});
	}

	async insertTurn(row: TurnInsert): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`insert into pi_tracker.turns (id, session_id, seq, status, usage, llm_count, tool_count, started_at, ended_at)
				 values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
				 on conflict (session_id, seq) do nothing`,
				[row.id, row.sessionId, row.seq, row.status, jsonb(row.usage ?? {}), row.llmCount, row.toolCount, row.startedAt, row.endedAt],
			);
		});
	}

	async insertEntry(row: EntryInsert): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`insert into pi_tracker.entries (session_id, entry_id, parent_id, seq, type, role, occurred_at, payload)
				 values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
				 on conflict do nothing`,
				[row.sessionId, row.entryId, row.parentId, row.seq, row.type, row.role, row.occurredAt, jsonb(row.payload)],
			);
		});
	}

	async insertLlmCall(row: LlmCallInsert): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`insert into pi_tracker.llm_calls
					(id, session_id, turn_id, provider, model, streamed, stop_reason, usage, tokens_in, tokens_out,
					 cache_read, cache_write, cost, duration_ms, ttft_ms, chunk_count, error, started_at, ended_at)
				 values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19)
				 on conflict do nothing`,
				[
					row.id,
					row.sessionId,
					row.turnId,
					row.provider,
					row.model,
					row.streamed,
					row.stopReason,
					jsonb(row.usage ?? {}),
					row.tokensIn,
					row.tokensOut,
					row.cacheRead,
					row.cacheWrite,
					row.cost,
					row.durationMs,
					row.ttftMs,
					row.chunkCount,
					jsonb(row.error),
					row.startedAt,
					row.endedAt,
				],
			);
		});
	}

	async insertToolCall(row: ToolCallInsert): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`insert into pi_tracker.tool_calls
					(id, session_id, turn_id, tool_call_id, tool_name, arguments, output, output_json, is_error, error,
					 exit_code, duration_ms, details, started_at, ended_at)
				 values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13::jsonb, $14, $15)
				 on conflict (session_id, tool_call_id) do nothing`,
				[
					row.id,
					row.sessionId,
					row.turnId,
					row.toolCallId,
					row.toolName,
					jsonb(row.args),
					row.output === null ? null : stripNulText(row.output),
					jsonb(row.outputJson),
					row.isError,
					jsonb(row.error),
					row.exitCode,
					row.durationMs,
					jsonb(row.details),
					row.startedAt,
					row.endedAt,
				],
			);
		});
	}

	async insertEvent(row: EventInsert): Promise<void> {
		return this.run(async () => {
			await this.client.query(
				`insert into pi_tracker.events (session_id, name, attributes, occurred_at) values ($1, $2, $3::jsonb, $4)`,
				[row.sessionId, row.name, jsonb(row.attributes ?? {}), row.occurredAt],
			);
		});
	}

	/** Drain the queue, then close the connection. */
	async close(): Promise<void> {
		this.closed = true;
		await this.queue;
		await this.client.end().catch(() => undefined);
	}
}
