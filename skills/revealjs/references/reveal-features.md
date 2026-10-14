# Reveal features

Everything here is stock. Reach for it before writing CSS.

## Speaker notes

Every slide with something to say out loud gets one. The prose lives here; the slide carries the short version.

```html
<aside class="notes">Batching is the thing teams get wrong first — lead with it.</aside>
```

Press `s` for speaker view. It is a popup and **requires the deck to be served over HTTP** — it will not work from `file://`. The `notes` plugin is already in the stock `index.html`.

## Fragments

Reveal one element at a time within a slide. Order follows document order unless `data-fragment-index` says otherwise.

```html
<li class="fragment">Appears on the next press</li>
<li class="fragment fade-up">Rises in</li>
<li class="fragment highlight-red">Turns red in place</li>
<li class="fragment fade-in-then-out">Appears, then leaves</li>
```

Available: `fade-in-then-out`, `fade-in-then-semi-out`, `fade-out`, `fade-up`, `fade-down`, `fade-left`, `fade-right`, `grow`, `shrink`, `highlight-red`, `highlight-green`, `highlight-blue`.

Use them where the sequence carries meaning — a build-up, a reveal, a correction. Do not fragment every bullet on every slide; it slows the deck to a crawl and adds nothing.

## Backgrounds

Per-slide, on the `<section>`:

```html
<section data-background-color="#1a1a1a">
<section data-background="assets/photo.jpg">
<section data-background-image="assets/photo.jpg" data-background-size="cover">
<section data-background-video="clip.mp4" data-background-video-loop>
<section data-background-iframe="https://example.com">
<section data-background-transition="slide">
```

A dark `data-background-color` on section dividers is a cheap, non-decorative way to give the deck structure. Full set in the clone at `examples/backgrounds.html`.

## Auto-animate

Matching elements between consecutive slides animate from one position to the other. Good for a diagram or number that evolves.

```html
<section data-auto-animate><h2>Rows scanned</h2><p style="font-size: 2em">1,000,000</p></section>
<section data-auto-animate><h2>Rows scanned</h2><p style="font-size: 4em">40,000</p></section>
```

Matching is by content, then by `data-id`. `data-auto-animate-id` groups slides; `data-auto-animate-unmatched="fade"` controls elements with no counterpart. See `examples/auto-animate.html`.

## Configuration

In the stock `index.html`, already present. Change only what the deck needs.

```js
Reveal.initialize({
  hash: true,             // deep-link to slides; keep this on
  slideNumber: false,     // 'c/t' to show current/total
  transition: 'slide',    // none / fade / slide / convex / concave / zoom
  center: true,           // false aligns content to the top — better for dense slides
  showNotes: false,       // true prints notes into the PDF export
  plugins: [RevealMarkdown, RevealHighlight, RevealNotes],
});
```

## Markdown slides

An alternative to HTML sections when the content is plain prose. The markdown plugin is already loaded.

```html
<section data-markdown>
  <textarea data-template>
    ## Slide title

    - point one
    - point two

    Note: speaker notes go after a Note: line
  </textarea>
</section>
```

Prefer HTML sections when the deck uses columns, icons or fragments — markdown makes those harder, not easier.

## Keyboard

Worth passing to the user at hand-off.

| Key | Does |
|-----|------|
| `→` `←` `space` | Navigate |
| `f` | Fullscreen |
| `esc` / `o` | Slide overview |
| `s` | Speaker view with notes |
| `b` / `.` | Blank the screen |
| `?` | All shortcuts |
| `alt`+click | Zoom into a region |
