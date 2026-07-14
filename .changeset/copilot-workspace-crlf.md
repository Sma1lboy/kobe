---
"@sma1lboy/kobe": patch
---

Fix Copilot session history, auto-title, and activity detection silently going blank when the CLI writes a CRLF `workspace.yaml` (as it does on Windows): the workspace parser now strips a trailing carriage return so the recorded `cwd` still matches the task's worktree instead of carrying a stray `\r` that failed every comparison — bringing it in line with the other porcelain parsers and the sibling events reader.
