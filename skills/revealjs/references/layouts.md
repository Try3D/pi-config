# Slide layouts

Vary the shape across the deck. A deck where every slide is a heading plus five bullets reads as machine-made regardless of how good the words are.

## Built-in helpers — prefer these

Reveal ships these; they need no custom CSS. Demonstrated in the clone at `examples/layout-helpers.html`.

| Class | Does |
|-------|------|
| `r-fit-text` | Scales text to fill the slide width. For a single big statement or number. |
| `r-stretch` | Makes an element as tall as it can be within the slide. For images and diagrams. |
| `r-stack` | Layers children on top of each other. With `fragment`, one replaces the next. |
| `r-hstack` | Lays children out in a row. |
| `r-vstack` | Lays children out in a column. |

```html
<h2 class="r-fit-text">10x</h2>

<img src="assets/diagram.png" class="r-stretch">

<div class="r-hstack">
  <p>Ingest</p><p>Store</p><p>Query</p>
</div>
```

## Title

```html
<section id="title">
  <h1>Postgres vs ClickHouse</h1>
  <p>Picking a store for analytics workloads</p>
  <aside class="notes">Frame it as a workload question, not a winner question.</aside>
</section>
```

## Section divider

A heading alone. It gives the deck rhythm and lets the audience reset.

```html
<section id="part-storage" data-background-color="#1a1a1a">
  <h2>Storage</h2>
</section>
```

## Bullets

Three to five, each a phrase not a sentence. If there are more, the slide is two slides.

```html
<section id="writes">
  <h2>Write path</h2>
  <ul>
    <li>Row inserts, one at a time — <strong>Postgres</strong></li>
    <li>Batched inserts, thousands at a time — <strong>ClickHouse</strong></li>
    <li>Small frequent writes are the failure mode</li>
  </ul>
  <aside class="notes">The batching requirement is the thing teams get wrong first.</aside>
</section>
```

## Two or three columns

For comparisons, options, or stages. See `style-kit.md` for the `.cols` rule.

```html
<section id="storage">
  <h2>Storage model</h2>
  <div class="cols">
    <div>
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      <h3>Row store</h3>
      <p>Whole rows together. Fast single-record reads.</p>
    </div>
    <div>
      <svg viewBox="0 0 24 24"><path d="M6 4v16M12 4v16M18 4v16"/></svg>
      <h3>Column store</h3>
      <p>One column together. Fast scans over few fields.</p>
    </div>
    <div>
      <svg viewBox="0 0 24 24"><path d="M4 18l6-8 4 5 6-9"/></svg>
      <h3>Consequence</h3>
      <p>The storage choice picks the workload for you.</p>
    </div>
  </div>
  <aside class="notes">This one decision explains most of what follows.</aside>
</section>
```

## One statement

When a single fact carries the slide, let it.

```html
<section id="scan">
  <h2 class="r-fit-text">40x fewer bytes read</h2>
  <p>Same query, same data, columnar layout.</p>
</section>
```

## Code

Keep under ~12 lines. `data-trim` strips surrounding whitespace, `data-noescape` allows raw HTML, and `data-line-numbers` takes ranges to step through with fragments.

```html
<section id="query">
  <h2>The query that decides it</h2>
  <pre><code class="language-sql" data-trim data-line-numbers="1|2-3">
    SELECT toStartOfHour(ts) AS h, count()
    FROM events
    WHERE ts > now() - INTERVAL 7 DAY
    GROUP BY h
  </code></pre>
  <aside class="notes">Scans one column across a week. This is where the gap shows.</aside>
</section>
```

## Table

Good for a real comparison with more than three rows — better than three columns of prose.

```html
<section id="compare">
  <h2>Side by side</h2>
  <table>
    <thead><tr><th></th><th>Postgres</th><th>ClickHouse</th></tr></thead>
    <tbody>
      <tr><td>Layout</td><td>Row</td><td>Column</td></tr>
      <tr><td>Writes</td><td>Single row</td><td>Batched</td></tr>
      <tr><td>Transactions</td><td>Full ACID</td><td>Limited</td></tr>
    </tbody>
  </table>
</section>
```

## Quote

```html
<section id="quote">
  <blockquote>Pick the store that matches the read pattern, not the one you know.</blockquote>
</section>
```

## Vertical stack

Nest `<section>`s to drill down. The audience moves right through the main thread and down only if the detail is wanted.

```html
<section>
  <section id="txn"><h2>Transactions</h2><p>Where the two genuinely diverge.</p></section>
  <section id="txn-pg"><h3>Postgres</h3><p>Full ACID, per-statement.</p></section>
  <section id="txn-ch"><h3>ClickHouse</h3><p>Atomic per-insert, no cross-table transactions.</p></section>
</section>
```

Use these when detail exists but is optional. Do not build the main argument vertically — most audiences never press down.
