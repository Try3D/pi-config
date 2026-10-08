# Pi extensions

Extensions for the [Pi coding agent](https://pi.dev).

| Extension | What it does |
| --- | --- |
| [pi-subagents](extensions/pi-subagents/README.md) | tmux-native subagents: `subagent` tool + `/agent:<name>` commands, one `_N` tmux window per run |
| [pi-sidebar](extensions/pi-sidebar/README.md) | Docked process panel that reflows the transcript (`Ctrl+Shift+S`, `/sidebar`) |
| [pi-title](extensions/pi-title/README.md) | Generates session titles from the first exchange (`/title`) |
| [pi-notify](extensions/pi-notify/README.md) | macOS notifications when a session finishes or needs attention |
| [pi-pg-export](extensions/pi-pg-export/README.md) | Exports interactive pi sessions to Postgres for auditability |
| [pi-mood](extensions/pi-mood/README.md) | Experimental footer mascot picked by a System One classifier (future-deprecated) |
| [pi-wait](extensions/pi-wait/README.md) | Queues a prompt after a delay with `/wait` |

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

The root `package.json` uses `"*"` for pi core `devDependencies`. The lockfile
resolves `@earendil-works/*` to registry tarballs, so `npm ci` installs them on
a fresh machine; the real hazard is version skew between that pinned copy and
the pi installation the extension actually runs in.

```sh
npm ci
npm run audit:code
```
