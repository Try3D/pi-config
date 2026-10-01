# pi-sidebar

A docked process panel that reflows the Pi transcript instead of covering it.

Pi's TUI has no sidebar region, so in fullscreen mode this wraps the renderer's
layout root in an `HStack`: `[ transcript + dock | sidebar ]`. Toggling the
sidebar resizes the transcript rather than overlaying it.

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
- Click a process row (inside tmux) to switch to that process's pane.

## Layout

A workspace-grouped process list. The panel truncates process labels to the
configured label width and clips rows from the bottom when the terminal is too
short.

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

`pi-subagents` names its subagent sessions `[agent:<name>] <task>`, so the
process list shows them with that prefix.
