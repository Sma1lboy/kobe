---
"@sma1lboy/kobe": patch
---

kobe-home is now a real home, not a dead end. Deleting the task you're in (when no other task is left) used to drop you on a bare shell that printed "No active task" with no sidebar and no way to make a new one. Now you land on a home that keeps the product's layout frame: the same fixed-width Tasks rail a real session carries on its left (focused, so `n` to create and arrows to pick work immediately) next to a "No task selected" welcome pane. Pick or create a task and you switch straight into its full session.

The task-bound panes (engine chat, file tree, Ops) are intentionally omitted from home — there's no worktree or engine to populate them until a task is entered. They come back the moment you switch into a task.

The same home backs the zero-task launch case: running `kobe` with no tasks at all used to error out with "no task available to enter" and exit to your shell. It now parks you on this home instead, so a fresh checkout (or one where you just deleted everything) lands somewhere you can actually start work.

Deleting or archiving the task you're in also keeps the sidebar honest. The flow switched the tmux client to the next task (so the chat pane was right) but never moved the shared active-task focus, so every Tasks pane kept highlighting the task you'd just removed. It now sets the active task to wherever the client landed (or clears it when you fall through to kobe-home), so the sidebar highlight always matches the chat pane — the same `setActiveTask` step `switchTo` already does on a normal switch.

Mechanics: `ensureFallbackSession` builds a welcome main pane plus a `kobe tasks` rail (`split-window -hb` at `TASKS_PANE_WIDTH`, keep-alive wrapped, cwd anchored to a directory that always exists) and tags the session `@kobe_home=tasks`. A legacy bare-shell kobe-home from an older build is rebuilt in place rather than reused, since tmux sessions outlive a kobe relaunch. `tui/direct.ts` attaches the home session on the zero-task path instead of bailing.
