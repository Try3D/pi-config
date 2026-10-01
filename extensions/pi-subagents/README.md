# pi-subagents

tmux-native subagents for the [Pi coding agent](https://pi.dev).

Each subagent is a separate `pi` session running in a tiled pane of the current
tmux session (4 panes per tab, overflow to `agents-2`, `agents-3`, …). The pane
streams the child's progress; the parent collects the final text and a git change
summary.

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
subagent({ agent: "scout", task: "find the auth flow" })
```

Human-facing commands:

```text
/agent:scout find the auth flow
/agent:worker refactor the parser
/agents                  list available agents
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
- Project agents override same-named user agents; pi-subagents reports the override at startup.

## How it works

- Spawns `pi --mode json -p --session-id <id> --name "[agent:<name>] <task>"` in a
  tmux pane via a generated `run.sh`. Naming the child up front makes subagent
  sessions identifiable in `/resume`, the tmux pane, and the sidebar; the child
  also gets `PI_AGENTS_AGENT=<name>`, which the `title` extension uses to keep the
  `[agent:<name>]` prefix if the title is regenerated.
- Raw events stream to `raw.jsonl`; the pane shows a `jq`-formatted view when
  `jq` is installed, and the raw JSON stream otherwise.
- The parent waits on an `exit` sentinel, then reads the last assistant message
  and `git status` / `git diff --stat` from the run cwd.
- Panes persist for 10 minutes after exit, then self-clean. Aborting a tool run
  kills the child pane; session shutdown aborts `/agent:<name>` command runs, and
  the extension notices a closed pane within a few seconds.

## Security

Project-local agents (`.pi/agents/`) are repo-controlled prompts and load only
for trusted projects. Subagents run with full system access, like any pi session.
