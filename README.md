# Pi extensions

Extensions for the [Pi coding agent](https://pi.dev).

| Extension | What it does |
| --- | --- |
| [pi-agents](extensions/pi-agents/README.md) | tmux-native subagents: `subagent` tool + `/agent:<name>` commands, 4 tiled panes per tab |
| [sidebar](extensions/sidebar/README.md) | Docked info panel that reflows the transcript (`Ctrl+Shift+S`, `/sidebar`) |
| [title](extensions/title/README.md) | Generates session titles from the first exchange (`/title`) |
| [notify-macos](extensions/notify-macos/README.md) | macOS notifications when a session finishes or needs attention |

## Install

Everything:

```sh
pi install git:github.com/rsaran/pi-extensions
```

One local extension while developing:

```sh
pi -e ./extensions/pi-agents/index.ts
```

## Development

The root `package.json` uses `"*"` for pi core `devDependencies`, which only
resolve when pi itself is present, for example when you install this repo inside
a pi installation. On a fresh machine, `npm install` will not resolve them from
the registry.

```sh
npm install
npm run check
```
