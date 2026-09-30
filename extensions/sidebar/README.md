# pi-sidebar

A docked info panel that reflows the Pi transcript instead of covering it.

Pi's TUI has no sidebar region, so in fullscreen mode this wraps the renderer's
layout root in an `HStack`: `[ transcript + dock | sidebar ]`. Toggling the
sidebar resizes the transcript rather than overlaying it.

## Install

```sh
pi install npm:@rsaran/pi-sidebar
# or locally
pi install ./extensions/sidebar
```

## Use

- `Ctrl+Shift+S` or `/sidebar` to toggle the panel.
