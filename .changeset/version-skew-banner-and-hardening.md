---
"@sma1lboy/kobe": patch
---

Warn when the running daemon is a stale build, and harden the new hook paths.

- **Version-skew banner.** After `npm i -g @sma1lboy/kobe@latest`, Bun's lack of hot-reload means the already-running daemon keeps executing the OLD code until `kobe daemon restart` (and panes until `kobe reload`) — silently masking the upgrade. The wire-protocol check only catches a breaking change, so a normal patch upgrade slipped through. Now the daemon advertises its build version on `hello` / `daemon.status`, and the Tasks pane shows a non-fatal top banner — `⚠ DAEMON OUT OF DATE … run \`kobe daemon restart\` then \`kobe reload\`` — that auto-hides once the daemon matches again. `kobe doctor` reports the skew too.
- **Hardening (from an adversarial review of the hook features):** `adoptWorktree` now serializes concurrent adopts of the same worktree path (a per-path lock) so two simultaneous WorktreeCreate hooks can't create duplicate tasks; the per-task hook install's `.git/info/exclude` write is guarded by a per-process set so the backfill path no longer re-spawns `git` on every task enter (and can't double-append); `kobe hook setup` persists the resolved settings path and cleans the previous location when you switch scope or run `--off`, so no orphaned hook is left behind; deleting a task now publishes an explicit `idle` so a reused task id can't inherit a stale activity badge.
