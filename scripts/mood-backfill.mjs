// Backfill pi-mood samples from pi-pg-export history.
//
//   node scripts/mood-backfill.mjs [--limit 200] [--concurrency 4] [--rps 4]
//                                  [--project <slug>] [--session <uuid>]
//                                  [--window 8] [--out <path>] [--dry-run]
//
// Rebuilds the state the mascot would have seen at each historical cut point
// (assistant message or tool result) using the same state builder as the live
// extension, classifies it with Jev, and appends the sample to a JSONL file in
// the same format as the live log. Safe to re-run: samples already present in
// the output are skipped.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { faceCriteria, INSTRUCTIONS, paletteEntries, pickFace, resetMoodHistory } from "../extensions/pi-mood/mood.ts";
import { clamp, renderState } from "../extensions/pi-mood/state.ts";

const MODEL = "jev-1.13-free";
const ENDPOINT = "https://opencode.ai/zen/v1/systemone";

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		if (key === "dry-run") out.dryRun = true;
		else out[key] = argv[++i];
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const dbUrl = args.db ?? process.env.PI_TRACKER_DATABASE_URL ?? "postgres://pi_tracker:pi_tracker@localhost:5433/pi_tracker";
const outPath = args.out ?? join(homedir(), ".pi", "agent", "pi-mood", "backfill.jsonl");
const limit = Number(args.limit) || Number.POSITIVE_INFINITY;
const windowSize = Number(args.window) || 8;
const concurrency = Number(args.concurrency) || 4;
const rps = Number(args.rps) || 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apiKey = process.env.OPENCODE_API_KEY ?? JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"))["opencode-go"]?.key;
if (!apiKey) {
	console.error("No OPENCODE_API_KEY and no opencode-go credential in auth.json");
	process.exit(1);
}

const paletteHash = createHash("sha1").update(JSON.stringify(faceCriteria)).digest("hex").slice(0, 12);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

let sessionQuery = "select id, cwd, started_at from pi_tracker.sessions";
const sessionParams = [];
if (args.session) {
	sessionQuery += " where id = $1";
	sessionParams.push(args.session);
} else if (args.project) {
	sessionQuery += " where project_id = (select id from pi_tracker.projects where slug = $1)";
	sessionParams.push(args.project);
}
sessionQuery += " order by started_at";
const sessions = (await client.query(sessionQuery, sessionParams)).rows;
console.error(`${sessions.length} sessions`);

const seen = new Set();
if (existsSync(outPath)) {
	for (const line of readFileSync(outPath, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (record.type === "sample" && record.entry) seen.add(record.entry);
		} catch {
			/* ignore malformed lines */
		}
	}
	console.error(`${seen.size} samples already in ${outPath}`);
}

/** The status line the agent would show right after this entry. */
function leadFor(entry) {
	if (entry.role === "assistant") {
		return entry.payload?.message?.stopReason === "toolUse"
			? "the agent is in the middle of running a tool, the work is not done yet"
			: "the agent just finished the work, the result looks good";
	}
	if (entry.role === "user" || entry.role === "toolResult") return "the agent is thinking about how to do the task, no tool has run yet";
	return "the agent is idle and waiting for the user";
}

function toolResultLine(entry) {
	const message = entry.payload?.message;
	const text = (message?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join(" ");
	return `${message?.toolName ?? "tool"} (error=${message?.isError ? "true" : "false"})${text ? ` ${clamp(text, 240)}` : ""}`;
}

const tasks = [];
for (const session of sessions) {
	const entries = (
		await client.query(
			"select entry_id, seq, role, occurred_at, payload from pi_tracker.entries where session_id = $1 and type = 'message' and role in ('user','assistant','toolResult') order by seq",
			[session.id],
		)
	).rows;
	const messages = entries.map((entry) => entry.payload?.message).filter(Boolean);
	for (let i = 0; i < entries.length; i++) {
		if (entries[i].role === "user") continue;
		if (seen.has(entries[i].entry_id)) continue;
		const lead = leadFor(entries[i]);
		const lastToolResult = entries[i].role === "toolResult" ? toolResultLine(entries[i]) : undefined;
		const state = renderState(lead, messages.slice(Math.max(0, i + 1 - windowSize), i + 1), lastToolResult);
		tasks.push({ session, entry: entries[i], state });
		if (tasks.length >= limit) break;
	}
	if (tasks.length >= limit) break;
}
await client.end();
console.error(`${tasks.length} states to classify${args.dryRun ? " (dry run)" : ""}`);

if (args.dryRun) {
	for (const task of tasks.slice(0, 3)) console.log(`\n--- ${task.session.id} seq ${task.entry.seq} ---\n${task.state}`);
	process.exit(0);
}

mkdirSync(dirname(outPath), { recursive: true });
if (!existsSync(outPath)) writeFileSync(outPath, `${JSON.stringify({ type: "palette", ts: new Date().toISOString(), hash: paletteHash, instructions: INSTRUCTIONS, criteria: faceCriteria, faces: paletteEntries })}\n`);

let nextSlot = 0;
async function throttle() {
	const now = Date.now();
	const wait = Math.max(0, nextSlot - now);
	nextSlot = Math.max(now, nextSlot) + 1000 / rps;
	if (wait) await sleep(wait);
}

let cursor = 0;
let done = 0;
let failed = 0;
async function worker() {
	while (cursor < tasks.length) {
		const task = tasks[cursor++];
		await throttle();
		const startedAt = Date.now();
		try {
			const response = await fetch(ENDPOINT, {
				method: "POST",
				headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
				body: JSON.stringify({ model: MODEL, state: { situation: task.state }, questions: { face: { type: "choice", instructions: INSTRUCTIONS, criteria: faceCriteria } } }),
			});
			const body = await response.json();
			if (response.status !== 200) {
				failed++;
				console.error(`  ${response.status} ${JSON.stringify(body).slice(0, 120)}`);
				continue;
			}
			resetMoodHistory();
			const { face, scores } = pickFace(body.answers.face.probabilities);
			appendFileSync(
				outPath,
				`${JSON.stringify({
					type: "sample",
					ts: new Date(task.entry.occurred_at).toISOString(),
					source: "backfill",
					session: task.session.id,
					entry: task.entry.entry_id,
					seq: Number(task.entry.seq),
					cwd: task.session.cwd,
					model: MODEL,
					provider: "opencode",
					palette: paletteHash,
					state: task.state,
					latencyMs: Date.now() - startedAt,
					choice: body.answers.face.choice,
					displayed: face,
					confidence: body.answers.face.confidence,
					probabilities: body.answers.face.probabilities,
					scores,
					usage: body.usage,
				})}\n`,
			);
			done++;
			if (done % 25 === 0) console.error(`  ${done}/${tasks.length}`);
		} catch (error) {
			failed++;
			console.error(`  ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.error(`wrote ${done} samples to ${outPath} (${failed} failed)`);
