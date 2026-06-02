---
"@sma1lboy/kobe": patch
---

Deleting a task no longer crashes the panes of the session you're in. Before, deleting the active task could drop the Ops pane (and the file tree) to a bare shell with a `posix_spawn 'tmux'` stack trace, leaving the GUI stuck in a half-cleaned state.

Root cause: every Tasks/Ops pane runs with its task's worktree as the process cwd. Deleting the task removes that worktree, but kobe kills the tmux session a beat later — and the kobe-owned panes inside it keep polling on their timers in between. Once the worktree is gone the kernel can't resolve the inherited cwd, so `Bun.spawn` fails with `posix_spawn` ENOENT *before the command runs* — even though tmux is on PATH. That throw landed in a pane's polling loop, and a pane process has no crash net (those are daemon-only), so the whole pane crashed to a shell.

Fixed in two layers:

- **The tmux spawn helpers tolerate a deleted cwd** (`tmux/client.ts`): every `Bun.spawn` is now anchored to a directory that always exists (`$HOME`) instead of inheriting the pane's worktree cwd, and a spawn failure degrades to a non-zero result instead of throwing. This protects *all* in-session pane spawns — the Ops activity/turn polls, the file tree's git polling, `send-keys`, etc. — not just one call site. `currentSessionName` keeps its documented "returns null when tmux can't answer" contract.
- **The Ops pane's poll loops swallow transient teardown errors** (`tui/ops/host.tsx`): the activity and turn-detector polls wrap their bodies so a failure during the delete→kill window degrades to a quiet no-op and the next tick retries, instead of becoming an unhandled rejection.
