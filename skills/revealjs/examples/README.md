# Examples

`deck.html` is a complete worked deck. It uses every pattern in `references/layouts.md` exactly once — title, section divider, three columns with icons, a single statement, code, bullets with a fragment, a vertical stack, a table, and a close — so it doubles as the argument for varying slide shape.

The `<style>` block is the entire style kit and nothing more: one accent colour, `text-transform: none`, and the `.cols` grid. Every rule in it is used by a slide below.

To run it, drop it into a reveal.js clone (the `dist/` paths are relative to the clone root) and serve:

```bash
cp deck.html <deck-slug>/index.html
cd <deck-slug> && python3 -m http.server 8000
```
