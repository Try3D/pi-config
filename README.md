# Pi extensions

Extensions for the [Pi coding agent](https://pi.dev).

| Extension | What it does |
| --- | --- |
| [pi-subagents](extensions/pi-subagents/README.md) | tmux-native subagents: `subagent` tool + `/agent:<name>` commands, 4 tiled panes per tab |
| [pi-sidebar](extensions/pi-sidebar/README.md) | Docked process panel that reflows the transcript (`Ctrl+Shift+S`, `/sidebar`) |
| [pi-title](extensions/pi-title/README.md) | Generates session titles from the first exchange (`/title`) |
| [pi-notify](extensions/pi-notify/README.md) | macOS notifications when a session finishes or needs attention |
| [pi-pg-export](extensions/pi-pg-export/README.md) | Exports interactive pi sessions to Postgres for auditability |

## Install

Everything:

```sh
pi install git:github.com/Try3D/pi-config
```

One local extension while developing:

```sh
pi -e ./extensions/pi-subagents/index.ts
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
