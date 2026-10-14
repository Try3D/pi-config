# Setup, serving and export

## Clone

```bash
git clone --depth 1 https://github.com/hakimel/reveal.js.git ./<deck-slug> && rm -rf ./<deck-slug>/.git
```

- `--depth 1` keeps it to ~19MB instead of the full history.
- `rm -rf .git` detaches it from upstream — this is the user's deck, not a fork of reveal.js. Skip this only if the user wants to track upstream.
- Clone into the current working directory unless the user names a location.

**`dist/` is committed in the reveal.js repo**, so the clone is immediately runnable. Do not run `npm install`, `npm start` or any build — none of it is needed, and `npm start` pulls in vite for no benefit.

## What the clone gives you

```
<deck-slug>/
├── index.html          ← the only file you edit
├── dist/
│   ├── reveal.js       prebuilt engine
│   ├── reveal.css      layout, required
│   ├── reset.css
│   ├── theme/          stock stylesheets
│   └── plugin/         notes.js, markdown.js, highlight.js, math.js, search.js, zoom.js
├── plugin/             plugin sources (ignore)
└── examples/           reference decks worth reading
```

The stock `index.html` already links `reset.css`, `reveal.css`, a stylesheet and the highlight styles, and initialises with the notes, markdown and highlight plugins. Leave all of it alone; replace only the two placeholder `<section>`s.

**Stylesheet load order matters:** `reveal.css` must come before the stylesheet in `dist/theme/`. Reversed, styling silently breaks.

## Serve

```bash
cd <deck-slug> && python3 -m http.server 8000
```

Then `http://localhost:8000`.

Serving is **required, not optional** — speaker view (`s`) opens a popup window that cannot reach the deck under `file://`, and the markdown plugin will not fetch external files either. Run the server through the `terminal` skill so it survives across turns and the user can watch it.

## Useful reading in the clone

| File | Why |
|------|-----|
| `examples/layout-helpers.html` | `r-fit-text`, `r-stretch`, `r-stack`, `r-hstack`, `r-vstack` demonstrated |
| `examples/backgrounds.html` | Every `data-background-*` variant |
| `examples/auto-animate.html` | Element-matching animation between slides |
| `examples/barebones.html` | Minimum viable deck |
| `examples/markdown.html` | Writing slides as markdown instead of HTML |
| `demo.html` | Fragment types, nesting, notes |

## Export a PDF

Append `?print-pdf` to the URL and print from the browser:

```
http://localhost:8000/?print-pdf
```

Then Print → Save as PDF, **Margins: None**, **Background graphics: on**. Chrome gives the most reliable output.

Speaker notes can be printed too by adding `showNotes: true` to `Reveal.initialize()` before exporting.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| Unstyled text on white | Stylesheet failed to load, or it is linked before `reveal.css` |
| Headings render ALL CAPS | Stock default; add `text-transform: none` (see `style-kit.md`) |
| Speaker view is blank | Opened over `file://` — serve it instead |
| Content runs off the slide | Too much on one slide; split it, do not shrink the text |
| Code block not highlighted | Missing `class="language-x"`, or the highlight plugin was removed from `plugins:` |
| Fragments do not advance | `class="fragment"` is on a container whose children are also fragments |
