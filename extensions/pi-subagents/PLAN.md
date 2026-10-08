# pi-subagents: tmux-native subagents for pi

## Purpose

A subagent yields exactly two things:

1. Changes to files on disk.
2. The final response.

Everything else (usage, session management) is secondary.

## tmux model

- Run only in the current tmux session. Use `$TMUX` and
  `tmux display-message -p '#{session_name}'` to get its name. Do not create or
  attach to other sessions.
- Append each new window at the end and name it with the smallest unused `_N`.
  Reuse a missing `_N` label, but do not insert a window at an earlier position.
- The pane shows the interactive pi TUI, not a JSON stream.

## Execution mode

- The child runs `pi "<task>"` (interactive TUI) in the pane, not
  `pi --mode json -p`. The TUI renders itself. It does not need a `jq` pipeline
  or `raw.jsonl`.
- The pane command does not use `run.sh`. TypeScript builds it and passes it to
  tmux as one shell string:
  - The env prefix includes `PI_SUBAGENT_RUN_DIR=<runDir>`,
    `PI_SUBAGENT_DEPTH=<depth>`, `PI_SUBAGENT_PARENT_PID=<pid>`, and
    `PI_SUBAGENT_KEEPALIVE_MS` when set.
  - It includes the resolved pi invocation and its shell-quoted arguments.
  - It redirects stderr to `stderr.log` with `2>stderr.log`.
  - tmux `-c <cwd>` sets the working directory.
  - tmux panes see the tmux server env, not the caller's. The command passes
    every needed variable explicitly.
- The `subagent` tool returns immediately with a run id (always background). It
  does not need to stream token deltas back to the parent.

## Completion contract

The extension installs the child hook (`child.ts`) only when
`PI_SUBAGENT_RUN_DIR` is set:

- `message_end` (assistant) tracks the latest text and `stopReason`.
- `agent_settled` writes `result.json` and arms the idle timer. The parent's
  watcher picks up the result and posts a notification.
- `session_shutdown` writes a `failed` result if the run never settled.

```
<runDir>/
  run.json      # static config: agent, depth, cwd, model, thinking, tools, promptPath, task, startedAt
  prompt.md     # agent system prompt (passed via --append-system-prompt)
  result.json   # child writes: { status, text, stopReason, sessionId, sessionFile, finishedAt }
  stderr.log    # child stderr
```

The parent polls `result.json`. If the pane disappears first, the parent treats
the run as a crash and returns the tail of `stderr.log`. The parent does not
need an exit sentinel.

## Keep-alive

- The pane stays open for 10 minutes after each settle. A keystroke, submitted
  prompt, new turn, or blocking dialog restarts the timer. When the timer
  expires, pi exits and the pane closes. Set `PI_SUBAGENT_KEEPALIVE_MS` to
  change the timeout.
- The parent returns when the first `result.json` appears. The live pane remains
  available for reading or follow-up turns.

## Resume

- `run.json` stores the data needed to relaunch the same session.
- `subagent({ agent_id, task })` and `/agents resume <runId> <task>` continue
  the run's existing session. The `agent_id` in each reply is the run id. The
  agent can continue the conversation without handling tmux or pane names.
- Resume sends the task to the run's live pane. If that pane is gone, it launches
  a new pane with the same session ID. The open command focuses the live pane or
  launches it if needed.
- `/agents open <runId>` opens the existing session without a task.
- `sessionId === runId`, so no extra lookup is needed.

## Recursion

- The root session has depth 0. The parent sets
  `PI_SUBAGENT_DEPTH = depth + 1`.
- At depth 4, `MAX_SUBAGENT_DEPTH = 4` prevents the extension from registering
  the `subagent` tool. Human commands have no depth limit.
- Nested subagents get their own windows. The sidebar displays them as a
  navigable tree.

## Components

```
pi-subagents/
  index.ts      # extension entry: child hook + `subagent` tool + command wiring
  child.ts      # child-side settle hook, keep-alive
  run.ts        # run dir/run.json, launch command, wait, resume, list, open
  shell.ts      # shell quoting + pi invocation resolution
  tmux.ts       # current-session window/pane management (open, kill)
  agents.ts     # agent definition discovery + frontmatter
  changes.ts    # git status/diff summary for a cwd
  commands.ts   # /agents, /agents runs|open|resume, /agent:<name>
```

## Human controls

- `/agent:<name> <task>` runs a named agent. If you omit the task, the input
  dialog asks for one.
- `/agents` lists agents.
- `/agents runs` lists recent runs.
- `/agents open <runId>` and `/agents resume <runId> <task>` reopen or continue a
  run.
- Tabs use names `_1`, `_2`, `_3`, and so on. Pane titles use `_N pi:<agent>`.

## Safety and edge cases

- If `$TMUX` is unset, the extension reports an error and explains that it only
  runs inside tmux.
- The extension rejects unknown `runId` values and invalid ids before it
  accesses the filesystem.
- Before a resume, the extension renames a stale `result.json` to
  `result.<timestamp>.json` so the old result cannot satisfy the new wait.
- The commands target only the pane recorded for each run.

## Phases

- Phases 0 and 1 are done. They add single-window execution and a cross-process
  allocation lock with `tmux wait-for`. They also handle aborts.
- Phase 2 (v2) is done. It adds full-TUI execution without `run.sh` or `jsonl`,
  the settle hook, a 10-minute keep-alive, resume commands (`resume`, `open`,
  `runs`), and depth-4 nesting.
- Background execution is always on: the single `subagent` tool returns a run id
  and takes `agent_id` to continue a run. Parent -> child messages are pasted
  into the child's pane; child -> parent results are written to `result.json`
  and delivered by the parent's watcher. The `/agents` commands cover
  runs/open/resume/steer/status/cancel.
- Parallel and chain modes are still planned. Per-agent settings are also
  planned.
