# pi-notify-macos

macOS notifications for the Pi coding agent.

- `agent_settled` → "finished" (fires only when Pi will not continue automatically)
- `ui_prompt_start` → "needs attention" (a blocking prompt appeared)

The notification title uses the project folder name so you know which window
finished. Only interactive sessions (TUI/RPC) notify; headless print/SDK runs
stay silent.

## Install

```sh
pi install npm:@rsaran/pi-notify-macos
# or locally
pi install ./extensions/notify-macos
```

macOS only.
