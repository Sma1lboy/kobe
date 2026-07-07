---
"@sma1lboy/kobe": patch
---

Terminal tabs now follow one model: every tab is a shell, an engine is just a process running in it. Tab default names are "$process $ordinal" ("claude 3", "shell 5") instead of "tab N"; split shell leaves and tab labels track the live foreground process via OSC window titles ("vim", "htop"), with engine titles normalized to one vocabulary ("✳ Claude Code" → "claude"). Typing `claude` inside a plain shell now attaches the same turn-status chip (●/✓) as a kobe-launched engine tab, and it detaches when the process exits. Fixes: a tab degraded to a shell no longer reopens as a fresh claude after restart; closing the engine leaf inside a split no longer leaves a stale turn chip flapping against a dead PTY; the corner name tag hides when a single leaf survives (the tab label already says it).
