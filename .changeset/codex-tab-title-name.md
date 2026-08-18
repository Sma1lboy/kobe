---
"@sma1lboy/rove": patch
---

Codex tabs wear their first prompt instead of a thread UUID

Codex's `thread-title` segment falls back to the thread IDENTIFIER while a
thread is unnamed, so codex tabs, sidebar rows, and the Inbox all read
`01a00ee9-f0e9-…` where claude and kimi read a sentence. The engine contract
now covers a title that isn't a name: an adapter declares
`sessionIdFromTitle` (the title IS a session id — never rendered, and the id
names the tab from that session's first prompt) or `isPlaceholderTitle` (noise
carrying no id), so the fix generalizes to the next engine with the same
problem instead of a vendor check in the TUI. Codex declares the first, which
also gives its tabs the first-prompt auto-title they could never reach before
(codex accepts no caller-set session id). Display-side, so snapshots already
holding a UUID heal on sight — and once codex names a thread, that name wins.
