---
"@sma1lboy/kobe": patch
---

fix: a corrupt `tasks.json` no longer silently loses your task list. Previously kobe recovered from an unparseable manifest by booting with an empty index and, on the very next save, rewriting the file from that empty base — permanently destroying every task row (and the worktrees/branches they pointed at) with no way back. kobe now copies the original bytes aside to a timestamped `tasks.json.corrupt-*` backup before recovering, and the startup warning points you at that file so your tasks can be restored by hand.
