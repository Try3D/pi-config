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

- `/title` regenerates the title now.
