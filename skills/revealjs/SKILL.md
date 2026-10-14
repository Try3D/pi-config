---
name: revealjs
description: Build reveal.js slide decks by cloning reveal.js locally and editing index.html. Use whenever the user asks for slides, a deck, a presentation, a slideshow, a talk, or says "turn this into slides", "make a deck", "present this" — including when they only supply notes or an outline.
metadata:
  author: Saran
---

# reveal.js decks

Clone reveal.js to disk, then write the deck by editing `index.html`.

## Golden rules

1. **Clone to the filesystem. Never use a CDN.** The deck works offline and stays pinned to the version cloned.
2. **Edit `index.html` only.** All slides live there. No build tooling, no splitting slides across files.
3. **Prefer reveal's built-ins over custom CSS.** `r-hstack`, `r-fit-text`, `r-stretch`, fragments and backgrounds cover most of what a deck needs. Custom CSS is a last resort, and `references/style-kit.md` is its entire vocabulary.
4. **Do not invent a look.** No topic-themed palettes, no font imports, no bespoke components. One accent colour is the whole colour budget.
5. **Follow the user's prompt for content.** Their words, their structure, their ordering.
6. **When in doubt, keep it simple.** Add something only when the content actually calls for it.

## Workflow

1. **Clone** into a directory named after the deck — see `references/setup.md`:
   ```bash
   git clone --depth 1 https://github.com/hakimel/reveal.js.git ./<deck-slug> && rm -rf ./<deck-slug>/.git
   ```
   `dist/` is committed upstream, so this runs immediately: no `npm install`, no build step. If the directory already exists, edit its `index.html` in place — never re-clone over someone's work.

2. **Plan the slides** before writing any. Decide the sequence and which shape each slide takes. Vary it — some bullets, some columns, some a single sentence. One repeated shape is what makes a deck feel machine-made.

3. **Add the style block** to `<head>` if the deck needs one — `references/style-kit.md`. At minimum `text-transform: none` on headings, since reveal uppercases them and that mangles acronyms like ClickHouse or gRPC.

4. **Write the slides** into `index.html`, replacing the two placeholder `<section>`s. Patterns are in `references/layouts.md`; `examples/deck.html` is a complete worked deck.
   - Every `<section>` gets a unique `id`.
   - **Fill in incrementally with `Edit`.** Do not regenerate the whole file with `Write` each time.
   - Every slide with something to say out loud gets `<aside class="notes">`. The prose goes in the notes; the slide carries the short version.
   - One idea per slide. If it will not fit, split it — never shrink text to compensate.

5. **Serve and check it renders** — `python3 -m http.server 8000` from the deck directory. Speaker view (`s`) is a popup that breaks under `file://`, so serving is required, not optional. Use the `terminal` skill to keep the server running.

6. **Hand off** with where the deck lives and how to drive it: arrows or space to move, `f` fullscreen, `esc` overview, `s` speaker view, `?` all keys, `?print-pdf` to export.

## Avoid the AI-generated look

The style kit is a ceiling, not a starting point. These give a deck away instantly:

- **No decorative lines.** No gradient rules under headings, no glowing accent bars, no divider strokes, no shadowed or bordered "cards" around ordinary text. Colour and whitespace do the separating.
- **No emoji.** Not as icons, not as bullets, not in headings. Inline SVG or nothing.
- **No filler prose.** No "In today's fast-paced world", no "Let's dive in", no "Key Takeaways" slide bolted onto content that has none.

Restraint plus real content reads as competent. Decoration reads as generated.

## References

Read these when you reach them, not upfront.

| File | Contents |
|------|----------|
| `references/setup.md` | Cloning, serving, PDF export, troubleshooting |
| `references/style-kit.md` | The complete custom-CSS vocabulary — accent colour, headings, columns, icons |
| `references/layouts.md` | Slide patterns and reveal's built-in layout helpers |
| `references/reveal-features.md` | Fragments, backgrounds, auto-animate, config, keyboard |
| `examples/deck.html` | A full worked deck using the kit |
