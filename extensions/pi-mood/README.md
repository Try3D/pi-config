# pi-mood

Shows a random face from [`emoticons.json`](emoticons.json) in the footer and swaps it every five seconds. It reads no session data and sends nothing over the network.

Set `PI_MOOD_DISABLE=1` to turn it off. pi-sidebar draws the mascot on the footer's working-directory line, so its footer must be visible.

Each entry needs an `emoticon` field. The other fields are unused.
