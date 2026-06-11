---
"@sma1lboy/kobe": patch
---

Overview cards in the web dashboard now show a one-line preview of the task's last user prompt, so the triage view answers "which task is this again?" without opening it. Previews come from the engine transcript through the existing history routes and are cached by transcript mtime — re-opening Overview costs one cheap sessions probe per task, and messages re-download only when the transcript actually changed. Codex tool-result plumbing on user-role records is skipped; a task with no prompt yet simply shows no preview line.
