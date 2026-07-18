---
"@sma1lboy/kobe": patch
---

Create PR is now `prefix+p` / `prefix+P` from any pane (the files-scoped `ctrl+p` is gone — it was unreachable from the sidebar and the terminal, which is where the muscle memory actually fired). The files-pane chip hint follows the configured prefix key, and firing Create PR on a session already sitting on the target branch (e.g. a project main session) now surfaces a toast instead of sending the engine a doomed `gh pr create`.
