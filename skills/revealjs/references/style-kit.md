# The style kit

**This is the complete custom-CSS vocabulary for a deck.** Do not invent beyond it — no topic-themed palettes, no font imports, no spacing systems, no bespoke components. Reach for `references/layouts.md` built-ins first; only add CSS the deck actually uses.

One `<style>` block in the `<head>`, after the existing `<link>` tags:

```html
<style>
  :root { --accent: #42affa; }              /* one accent colour, that is all */

  .reveal h1, .reveal h2, .reveal h3 { text-transform: none; }
  .reveal h2 { color: var(--accent); }
  .reveal strong { color: var(--accent); }

  .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; text-align: left; }
  .cols h3 { margin-top: 0; font-size: 0.8em; }
  .cols svg { width: 48px; height: 48px; stroke: var(--accent); fill: none; stroke-width: 1.5; }
</style>
```

## Headings

`text-transform: none` is the one rule worth adding unprompted. reveal.js uppercases headings by default, which mangles acronyms and proper nouns — ClickHouse becomes CLICKHOUSE, gRPC becomes GRPC. Include it in every deck.

## Colour

Exactly **one** accent, declared once in `--accent`. Use it on headings and `<strong>` and nowhere else. Keep the stock background and body text.

`#42affa` is reveal's own link blue and a fine default. Change it only if the user names a colour or the deck is for an organisation with a known one. **Do not pick a colour to match the topic** — a database talk does not need to be blue, a finance talk does not need to be green. That instinct is exactly what makes decks look generated.

## Columns

`.cols` for two or three side-by-side items — comparisons, options, stages of a process. Switch `repeat(3, 1fr)` to `repeat(2, 1fr)` for two. Never narrower than two columns of real content.

Reveal's built-in `r-hstack` handles simple horizontal rows without any CSS at all; prefer it when the items are not equal-width blocks of text. See `layouts.md`.

## Icons

**Inline SVG only.** Never an icon-font CDN — the deck has to work offline, and that is the whole reason for cloning.

- A simple stroked outline, 48px, `stroke: var(--accent)`, `fill: none`.
- One per column heading at most.
- **Skip the icon rather than reach for a weak metaphor.** A lightbulb next to "Insights" adds nothing. If no obvious glyph exists, leave it out — three columns with no icons look considered; three with bad icons look padded.

Workable primitives, all on a `0 0 24 24` viewBox:

```html
<!-- rows / list -->      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
<!-- columns -->          <svg viewBox="0 0 24 24"><path d="M6 4v16M12 4v16M18 4v16"/></svg>
<!-- trend up -->         <svg viewBox="0 0 24 24"><path d="M4 18l6-8 4 5 6-9"/></svg>
<!-- clock / latency -->  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
<!-- database -->         <svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/></svg>
<!-- warning -->          <svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
```

## What not to add

- Gradient rules, glowing bars, divider strokes, drop shadows.
- Bordered or filled "cards" wrapping ordinary text.
- A second or third colour.
- `@import` of any font.
- Utility class systems. If a pattern appears once, use the built-in or inline it.
