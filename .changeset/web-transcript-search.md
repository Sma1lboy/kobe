---
"@sma1lboy/kobe": patch
---

The web dashboard's Chat transcript gains a search box: filter a session down to the messages that match a query, with a live "shown / total" count. It searches all of a message's content — prose, thinking, tool-call names + inputs, and tool result output — so a filename, command, or error term jumps you to the relevant turns in a long session (e.g. narrowing a 359-message transcript to the 2-4 that mention what you're looking for). The query clears on task/vendor switch, and an empty result shows a "No messages match" hint.
