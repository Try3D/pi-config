# pi-title

Names each Pi session from its first exchange with a small LLM call.

The generated name is written with `setSessionName`, so it persists in the
session file and shows up in `/resume`, the terminal title, and any sidebar
reading session names.

## Install

```sh
pi install npm:@rsaran/pi-title
# or locally
pi install ./extensions/title
```

## Use

- `/title` regenerates the title now.
