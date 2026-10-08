# pi-mood

Shows a tiny footer mascot whose reaction to the current coding session is chosen by a System One classifier ([Jev](https://docs.typesafe.ai)) through pi's model registry. The classifier reads the live session state — the running tool and its arguments, the agent's reasoning traces and tool calls, the last tool result, and the recent prompts — and picks one face from `emoticons.json`. It re-reads that state every 5 seconds while it changes, so the mascot tracks what the agent is doing, not just what you typed. The extension adds no rules of its own, and runs no local model.

This needs a classifier the account can use. Run `pi` and check the available classifier models; good options are the `opencode` provider's `jev-1.13-free`, or a Jev model on `openrouter`, `cloudflare-workers-ai`, or `typesafe`. Set that provider's credentials (for `opencode`, `OPENCODE_API_KEY`) and pi-mood finds the model automatically.

The faces come from [`emoticons.json`](../../emoticons.json) at the repository root. Each entry has three fields:

- `emoticon` – the face to render.
- `mood` – the short label the classifier chooses between; keep these distinct so it can tell them apart.
- `description` – what the face is.
- `use_when` – when that face fits.

Faces are weighted by how often they have already appeared, so each appearance makes a face less likely without ever ruling it out: a strong match can still win and repeat. Set `PI_MOOD_DECAY` to tune this (default `0.5`, where each previous appearance multiplies the weight; `1` disables the variety).

Each classification is a network call (roughly a second). If the call fails or no classifier is available, the previous face stays. Set `PI_MOOD_DISABLE=1` to disable the extension. The mascot is placed on the footer's working-directory line, so `pi-sidebar`'s footer must be visible.

## Sample log

Every classification is appended to `<agent dir>/pi-mood/log.jsonl` (override with `PI_MOOD_LOG`, disable with `PI_MOOD_LOG=off`). Each line is one record:

- `{"type":"palette",…}` — the instructions, the full criteria map, and `faces` (every option key with its glyph, mood, description, and `use_when`), written once per process. Its `hash` identifies the palette.
- `{"type":"sample",…}` — `state`, `choice` (the classifier's key), `displayed` (the face actually shown), `confidence`, `probabilities` (the raw distribution), `scores` (the same after presence weighting), `usage`, `latencyMs`, `session`, `cwd`, `model`, `provider`, `palette`.
- `{"type":"error",…}` — a failed call.

`node scripts/mood-dataset.mjs [--min-confidence 0.5]` emits the palette records once, then every sample record unchanged, so the output is self-contained and lossless.
