---
"@sma1lboy/kobe": patch
---

Sidebar: the task whose terminal you're currently viewing no longer draws kobe's own engine spinner. The live terminal already shows claude/codex's own zero-latency spinner, so the sidebar row defers to it instead of animating a duplicate that's necessarily a beat behind. Unfocused rows still spin (their terminal isn't on screen, so kobe's signal is the only liveness cue), and a materializing worktree job still spins even on the viewed row since no terminal exists yet.
