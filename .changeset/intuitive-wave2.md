---
"@sma1lboy/kobe": patch
---

**Custom engines and the engine panes are easier to live with.** Every engine/shell pane now shows a tiny dimmed hint of the escape hatches (`^h tasks  ^q detach  ^t tab`) on the tmux status line, so you're never stuck inside the engine pane not knowing how to get back to the task list or detach. The `Ctrl+T` / `prefix T` "new engine tab" prompt now accepts your registered custom engines (not just claude/codex/copilot) and, when you mistype an engine name, says so with a visible message instead of silently doing nothing. A custom engine whose launch command is wrong (a typo'd binary) now prints a clear "Engine exited (code N) — check Settings → Engines, press R to relaunch" banner in the pane instead of dropping you onto a bare shell that looks like nothing happened. And a custom engine added without a display name now shows a tidy title-cased label ("My Local Agent") instead of its raw `my-local-agent` slug.
