---
"@sma1lboy/kobe": patch
---

The web dashboard's Chat transcript can now be copied as Markdown — a new button in the transcript header serializes the session you're looking at (respecting the active search filter and the hide-tools toggle, so you export exactly what's on screen) into a clean Markdown document on the clipboard, with a toast confirming the message count. Tool calls render as `↳ name` lines with their (truncated) output attached, thinking as blockquotes, and the heading carries the task title, engine, and message count — so you can paste a session into a doc, an issue, or a message to a friend.
