# pi-pg-export

Export interactive pi editor sessions to Postgres for auditability.

Unlike the `pibox` approach (which drives pi through the SDK), this is a plain pi
extension that loads into whatever session you are actually typing in and mirrors
prompts, responses, thinking, tool calls, LLM usage, and a lifecycle event
timeline into Postgres. Writes are fire-and-forget, so a database outage never
breaks the agent.

The extension is self-contained (this directory); the schema migrations and the
observability dashboard live in the separate `pi-tracker` app (DB migrations + UI).

## What gets captured

| Table | Contents |
|---|---|
| `pi_tracker.projects` | one row per working directory |
| `pi_tracker.sessions` | per session: cwd, file, mode, status, message count, rolled-up usage |
| `pi_tracker.entries` | the full session tree: user prompts, assistant text + thinking, tool results, compaction, model/thinking changes |
| `pi_tracker.llm_calls` | one row per assistant response: provider, model, stop reason, tokens, cache, cost, duration, TTFT, chunk count |
| `pi_tracker.tool_calls` | one row per tool execution: arguments, output, error, exit code, duration |
| `pi_tracker.events` | audit timeline: session start/shutdown, inputs, model/thinking switches, provider responses, user bash |

## Configuration

All optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PI_TRACKER_DATABASE_URL` | (required) | Postgres connection; export is disabled when unset |
| `PI_TRACKER_PROJECT` | basename of the session cwd | project slug |
| `PI_TRACKER_PAYLOADS` | unset | when truthy (`1`/`true`/`yes`), also store the full provider request payload per call (large) |
| `PI_TRACKER_DISABLE` | unset | when truthy (`1`/`true`/`yes`), load the extension but write nothing |

## How it works

- `session_start` opens a `pg` client, upserts the project + session, and backfills
  existing entries for resumed sessions.
- `message_start/update/end` produce `llm_calls` (with stream timing).
- `tool_execution_start/end` produce `tool_calls`.
- Pi writes session entries without emitting events, so the tracker polls
  `ctx.sessionManager.getEntries()` at turn boundaries (`turn_end`, `agent_end`,
  `agent_settled`) and on shutdown. A `seenEntries` set keeps this idempotent.
- One queued `pg` client serializes all writes to preserve the timeline.

## Limitations

- `entry_appended`, `queue_update`, `auto_retry_*`, and `compaction_start` are
  SDK-only events and are not exposed to extensions, so entry capture is poll-based
  and automatic retries are not recorded individually.
- The extension strips base64 image data before persisting and truncates long strings.
- The extension applies no secret redaction. Add a redaction step before production use if
  prompts or tool output may contain credentials.
