# pi-wait

Queue a prompt to send to the current session after a delay.

## Install

```sh
pi install npm:@rsaran/pi-wait
# or locally
pi install ./extensions/pi-wait
```

## Use

- `/wait <duration> [prompt]` queues `prompt` to send after `duration`. With no
  prompt, it reschedules an already-queued wait.
- `/wait now` sends the queued prompt immediately.
- `/wait pause` pauses the countdown.
- `/wait resume` resumes a paused countdown.
- `/wait cancel` drops the queued prompt.
- `/wait status` shows the queued prompt and time left.

Durations take an optional unit and default to seconds: `30`, `5s`, `5m`, `1h`,
`500ms`. The maximum is 24h.

If the agent is busy when you queue the wait, the countdown starts once it
settles. The pending wait survives `/reload`, and the extension restores it from the session.
