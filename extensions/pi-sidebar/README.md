# pi-sidebar

A docked process panel that reflows the Pi transcript instead of covering it.

Pi's TUI has no sidebar region, so in fullscreen mode this wraps the renderer's
layout root in an `HStack`: `[ transcript + dock | sidebar ]`. Toggling the
sidebar resizes the transcript rather than overlaying it. Outside fullscreen
mode there is no layout root to wrap, so regular mode falls back to a
content-covering overlay; use fullscreen mode for docking.

## Install

```sh
pi install npm:@rsaran/pi-sidebar
# or locally
pi install ./extensions/pi-sidebar
```

## Use

- `Ctrl+Shift+S` or `/sidebar` to toggle the panel.
- `/sidebar left|right` moves it; `/sidebar on|off` shows or hides it explicitly.
- `/sidebar width 40` sets the column width (`/sidebar width` reports it); the extension clamps it to 16-80 and persists it.
- `/sidebar reload` sends `/reload` to every other pi pane in tmux.
- Click a row with a detected tmux pane to switch to that process's pane.

## Layout

Every pane shows the same process tree. It groups root sessions by workspace
and nests subagents under the process that spawned them, using tree connectors.
Subagent rows start with their tmux tab id, such as `_1` or `_2`, so they line
up with the tab bar. Each pane highlights the current session.

A subagent pane has a right-aligned `go up` button, marked by the U+F148
level-up arrow, on its workspace heading. Click it to switch to the immediate
parent session. The panel truncates process labels to the configured label
width and clips rows from the bottom when the terminal is too short.

On narrow terminals, the docked column shrinks below its configured width, down
to 16 columns, to leave at least 30 columns for the transcript. The panel hides
only when the terminal is narrower than 46 columns.

The panel is process-only. Model, directory, and branch already live in the
footer below the editor. The footer drops the token/cache/cache-hit stats,
replaces the `0.0%/1.0M (auto)` context readout with a `ctx` usage bar, and keeps
the cost and model.

## Configuration

The docked width and process-label width live under `custom.sidebar` in
`~/.pi/agent/settings.json` (respects `PI_CODING_AGENT_DIR`):

```json
{ "custom": { "sidebar": { "width": 34, "labelWidth": 20 } } }
```

`/sidebar width <n>` and `/sidebar label-width <n>` update them at runtime and
write the file, so the chosen values survive restarts (`width` 16-80, `labelWidth`
8-60).

## Live activity

Every pane publishes its own status (`label`, `cwd`, tmux pane, and whether it is
currently generating) to `~/.pi/agent/sidebar/<pid>.json`. Each sidebar watches
that directory, so:

- rows show a spinner while that pane is generating, and the sidebar accents the current session's label;
- the spinner animates only while something is streaming, and the panel clears
  the interval on shutdown.

`pi-subagents` names subagent sessions after their task, so the process list
shows the task text. The icon and `_N` tab id identify subagent sessions.
