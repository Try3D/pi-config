# pi-notify-macos

macOS notifications for the Pi coding agent.

- `agent_settled` sends "finished" when Pi will not continue automatically.
- `ui_prompt_start` sends "needs attention" when a blocking prompt appears.

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
