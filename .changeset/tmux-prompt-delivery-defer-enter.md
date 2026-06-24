---
"@sma1lboy/kobe": patch
---

Prompts delivered into a tmux engine pane (the repo `init-prompt.md` first message, `kobe api send`, and quick-task delivery) no longer occasionally sit unsent in the composer. `pasteAndSubmit` wrote the bracketed paste and the submit Enter back-to-back, so they could coalesce into one tty read and the engine treated the carriage return as paste content instead of a submit — the same failure the web composer and PTY sidecar already fixed by deferring the Enter ~150ms (CHANGELOG 8f6dd64). The tmux delivery path now applies the same split.
