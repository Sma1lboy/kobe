---
"@sma1lboy/kobe": patch
---

Cross-mode session sync: opening a task in the pure-TUI workspace (`KOBE_TUI=1`) for the first time now adopts the task's newest existing conversation from the engine's own on-disk store — so sessions created under the tmux flavour (or a previous install) continue where they left off instead of starting blank. Works for both claude (`--resume <id>`) and codex (`codex resume <id>`) through a new engine-owned `resumeCommand` registry hook; engines without resume support (copilot, custom) keep starting fresh. The adopted tab auto-names itself from the conversation's first prompt like any other tab.
