---
"@sma1lboy/rove": patch
---

Codex tabs are named after their conversation instead of a thread UUID. Codex's terminal-title segment falls back to the raw thread id for any session without a user-assigned name, so every Codex tab read `01a00ea6-79cb-7413-bf83-b897ac2da2ff 1`. Engines now declare which of their titles are identifiers rather than names (`terminalTitle.placeholderTitles`), and Rove falls through to its own first-prompt summary when one shows up — including for titles already recorded in an older snapshot, which heal on display. Engines Rove can't pin a session id on (Codex, Copilot, Kimi) also get that first-prompt name for the first time, derived from the worktree's origin conversation.
