# pi-agents — tmux-native subagents for pi

## Purpose

A subagent yields exactly two things:

1. **Mutations** — file changes on disk.
2. **The text** — its final response.

Everything else (usage, session management) is secondary.

## tmux model

- Run **only in the current tmux session** (here: `pi-agents`). Never create or
  attach to other sessions.
- Session name/pane target comes from `$TMUX` +
  `tmux display-message -p '#{session_name}'`.
- A **new window (tab) per batch of 4 subagents**.
- Up to **4 tiled panes per tab** (2x2 via `select-layout tiled`).
- 5th subagent opens the next tab.
- Panes show the subagent's output live.

## Execution mode (forced by constraints)

- Interactive TUI -> has an input box. **Rejected.**
- `-p` text mode -> prints only the final text, nothing while running.
  **Useless for observability** (verified in a real TTY).
- Therefore: **`pi --mode json -p`** in each pane. Streams events live, exits
  when done, no input box.

Pane rendering:

- Default: raw JSON event stream (simple, truthful).
- Optional: a `jq` one-liner to humanize text deltas + tool calls, e.g.
  ```
  pi --mode json -p ... | tee "$RUN/raw.jsonl" \
    | jq -r --unbuffered '
        if .type=="message_update" and .assistantMessageEvent.type=="text_delta"
          then .assistantMessageEvent.delta
        elif .type=="message_end" and .message.role=="assistant" then
          (.message.content[]? | if .type=="toolCall"
            then "→ \(.name) \(.arguments)" else empty end)
        else empty end'
  ```
  Raw JSONL still goes to `raw.jsonl` for the parent.

## Result assembly

- **Text**: last assistant `message_end` in `raw.jsonl` (or the session file).
- **Mutations**: `git -C <cwd> status --porcelain` + `git diff --stat`.
- **Done**: the child process exits (non-interactive), so exit code is the
  signal. `agent_settled` is available in the stream if needed.
- **Failure**: non-zero exit, or `stopReason` of `error`/`aborted`.

## Lifecycle

- After the child exits, the pane **persists for 10 minutes**, then self-kills:
  `tmux set-window-option remain-on-exit on` (or run a shell that sleeps) plus a
  detached `sleep 600 && tmux kill-pane -t <pane>`.
- Parent abort (Ctrl+C) kills the child panes.
- Empty/killed panes are reused for later subagents if convenient.

## Components

```
pi-agents/
  index.ts      # extension entry: `subagent` tool + /agents commands
  agents.ts     # agent definition discovery + frontmatter
  tmux.ts       # current-session pane/window management (split, tile, kill)
  run.ts        # build child command, spawn in pane, tee raw.jsonl, collect
  changes.ts    # git status/diff summary for a cwd
  agents/       # sample agent definitions (.md)
```

## Agent definitions

Markdown + YAML frontmatter from `~/.pi/agent/agents/` and (trust-gated)
`.pi/agents/`:

```markdown
---
name: worker
description: General-purpose subagent
model: opencode-go/deepseek-v4.1-flash
tools: read, grep, find, ls, bash, edit, write
---

System prompt: what this agent is for and the shape of its final answer.
```

No `model` => inherit the dispatching session's model/thinking level.

## Modes

`subagent` tool:

| Mode     | Params             | Behavior                                     |
|----------|--------------------|----------------------------------------------|
| single   | `{ agent, task }`  | 1 pane, wait for exit, return                |
| parallel | `{ tasks: [...] }` | up to 4 panes/tab (next tab overflows), wait |
| chain    | `{ chain: [...] }` | sequential panes, `{previous}` substitution  |

## Human controls

- `/agent:<name> <task>` — run a named agent directly (e.g. `/agent:scout find auth code`).
  With no task, prompts for one via the input dialog.
- `/agents` — list available agents and their commands.
- Panes/windows: tab named `agents-N`; pane titles `pi:<agent>:<shortid>`.
- TODO: `/agents jump <id>` and `/agents kill <id>`.

## Safety & edge cases

- If `$TMUX` unset: error clearly (this extension is tmux-only by design).
- Project-local agents gated behind project trust.
- Never touch panes/windows that are not ours (identify by window name prefix).
- Preserve the user's existing pane layout; only mutate our own tabs.

## Open decisions

1. **Pane rendering**: raw JSON (simplest) vs the `jq` humanizer (recommended for
   2x2 panes where raw JSON is hard to read)?
2. **Sessions**: `--no-session` (ephemeral) vs `--session-id <id>` (resumable /
   inspectable later)?
3. **Agents dir**: reuse `~/.pi/agent/agents/` (recommended) vs
   `~/.pi/agent/pi-agents/agents/`.
4. **Persistence timer**: default 10 minutes — configurable per agent?
5. **Overflow**: >4 tasks -> new tab per 4 (recommended) vs cap at 4.

## Phases

- **Phase 0**: DONE. `agents.ts` + `tmux.ts` + `run.ts` + `changes.ts`, single-mode
  `subagent` tool: spawns a new tab in the current session, waits for exit,
  returns final text + git summary. Verified end-to-end.
- **Phase 1**: DONE. Tiling to 4 panes/tab (`agents`, `agents-2`, ...), mutex-guarded
  allocation, 10-min pane persistence, abort kills panes.
- **Phase 2**: parallel + chain modes, tab overflow.
- **Phase 3**: `/agents` list/jump/kill.
- **Phase 4**: trust gating, sample agents, docs.
