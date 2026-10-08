# pi-subagents

tmux-native subagents for the [Pi coding agent](https://pi.dev).

Each subagent runs an interactive `pi` session in its own tmux window (tab).
The window is added at the end and named `_1`, `_2`, `_3`, and so on. The pane
shows the full TUI.

By default, subagents run in the background: the parent gets a `run_id`
immediately and a follow-up notification when the agent completes. The pane
stays open for 10 minutes after each settle so you can read or steer it. A
keystroke, submitted prompt, new turn, or blocking dialog restarts the timer.
When the timer expires, pi exits and the pane closes. Set
`PI_SUBAGENT_KEEPALIVE_MS` to change the timeout.

## Install

```sh
pi install npm:@rsaran/pi-subagents
# or locally from this repo
pi install ./extensions/pi-subagents
```

Requires tmux and pi running inside a tmux session.

## Use

LLM-facing tool:

```text
subagent({ task: "find the auth flow" })
// defaults to the built-in general agent; returns a run_id immediately;
// the subagent pastes its result here when it settles

subagent({ agent: "scout", task: "find the auth flow" })
// use a named agent definition

subagent({ agent_id: "scout-mu4x...", task: "now trace the token refresh path" })
// send a message to an existing run (pasted into its pane)
```

Human-facing commands:

```text
/agent:scout find the auth flow     run an agent in the background
/agents                             list available agents
/agents runs                        list recent runs with their status
/agents open <runId>                reopen a past run's session in a pane
/agents resume <runId> <task>       continue a past run with a new task
/agents steer <runId> <task>        send a queued message to a running agent
/agents status <runId>              check status or final result
/agents cancel <runId>              stop a run
```

## Agent definitions

Agents are markdown files with YAML frontmatter, discovered from
`~/.pi/agent/agents/*.md` (user) and `.pi/agents/*.md` (project, trust-gated):

```markdown
---
name: worker
description: General-purpose subagent
model: opencode-go/deepseek-v4.1-flash
tools: read, grep, find, ls, bash, edit, write
---

System prompt for the agent.
```

- Any new `.md` becomes `/agent:<name>` after a session restart or `/reload`.
- Omit `model` to inherit the dispatching session's model and thinking level.
- Omit `tools` for full capabilities; otherwise the child only gets the listed tools.
- Omit `agent` on the `subagent` tool to use the built-in `general` agent
  (full tools, inherited model, minimal system prompt).

## How it works

- The parent launches `pi --session-id <runId> --name "<task>" "<task>"` in a
  tmux pane. The child is a full interactive pi session (not `--mode json`),
  named with the task so it is identifiable in `/resume` and the sidebar; the
  tmux pane title is `_N pi:<agent>`.
- The child hook writes `result.json` (final text, status, session file) when
  the agent settles. A parent-side watcher polls for this file and posts a
  follow-up notification.
- The parent sends a message to a running subagent by pasting it into the
  child's pane; Pi queues the input as steering when the child is mid-turn. If
  the pane is gone the run is relaunched with the same session id and the task
  is passed as the prompt.
- The pane stays open for 10 minutes after each settle. A keystroke, submitted
  prompt, new turn, or blocking dialog restarts the timer. When the timer
  expires, pi exits and the pane closes. Set `PI_SUBAGENT_KEEPALIVE_MS` to
  change the timeout.
- Every run writes `run.json` under `<agentDir>/pi-subagents/runs/<runId>/`
  (default `~/.pi/agent/pi-subagents/runs/<runId>/`; respects
  `PI_CODING_AGENT_DIR`). When it creates a run, the extension prunes run
  directories older than seven days.
- The `agent_id` from a reply continues the same session, reusing its live pane
  when available.
- Subagents can nest up to depth 4. At depth 4, the extension does not register
  the `subagent` tool, so a child cannot spawn another subagent.

## Lifecycle and failure

- The watcher detects a crash when the pane disappears and reports the tail of
  `stderr.log` as the failure reason.
- `/agents cancel <runId>` kills the pane and records a failed result.
- Session shutdown stops the parent's watchers (running panes are left alive).

## Security

Project-local agents (`.pi/agents/`) are repo-controlled prompts and load only
for trusted projects. Subagents run with full system access, like any pi session.
