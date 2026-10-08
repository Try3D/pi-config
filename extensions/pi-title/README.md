# pi-title

Names each Pi session from its first exchange with a small LLM call.

The extension writes the generated name with `setSessionName`, so it persists in
the session file and shows up in `/resume`, the terminal title, and any sidebar
that reads session names.

## Install

```sh
pi install npm:@rsaran/pi-title
# or locally
pi install ./extensions/pi-title
```

## Use

The extension auto-titles a session 60 seconds after its first user message, as
long as the session is still unnamed and the agent is idle. It retries later if
the agent is busy instead of dropping the title.

Commands:

- `/title` regenerates the title now.
- `/title set <text>` sets a title, for text that starts with a keyword such as
  `model` or `config`.
- `/title <text>` sets a title from free text.
- `/title model` shows the configured and session models.
- `/title model <ref>` sets the model used for titling. `<ref>` is `null` or
  `active` for the session model, `auto`, or `provider/model[:effort]`.
- `/title on` / `/title off` enables or disables automatic titles.
- `/title config` shows the effective configuration and settings path.

## Configuration

Config lives under `custom.title` in `~/.pi/agent/settings.json` (honoring
`PI_CODING_AGENT_DIR`). The extension reads it at session start:

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | whether to auto-title new sessions |
| `model` | `null` | model ref for titling; `null` uses the session model |
| `maxTokens` | `30` | output budget for the title call (capped at 4096) |
| `maxLength` | `60` | maximum title length |

```json
{ "custom": { "title": { "model": "opencode/jev-1.13-free", "maxLength": 60 } } }
```
