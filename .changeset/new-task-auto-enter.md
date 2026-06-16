---
"@sma1lboy/kobe": patch
---

Creating a task with `n` now drops you straight into the new task's engine pane, ready to type the first prompt — instead of just landing the cursor on it in the Tasks list. The full new-task flow now mirrors the prompt-first `f` quick-create's jump on both surfaces (the dedicated `kobe new-task` tab and the in-pane overlay), and the repo's `init-prompt.md` fires as the engine's first message just as it does on a normal enter. Adopting existing worktrees enters the last one. The proven "build session + switch-client" jump is now a shared helper reused by quick-task, new-task, and the Tasks pane.
