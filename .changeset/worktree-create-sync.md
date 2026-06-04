---
"@sma1lboy/kobe": patch
---

Sync external `claude --worktree` worktrees into kobe as tasks.

When Claude Code creates a worktree OUTSIDE kobe (`claude --worktree`), kobe can now adopt it as a task automatically so it shows up in the Tasks list with its diff — no conversation required; you can open a chat in it later. Opt-in via `kobe hook setup` (writes a `WorktreeCreate` hook into `~/.claude/settings.json` global by default, or `--repo <path>` for one repo, or `--off` to remove); the hook is tagged + merge-safe so it never clobbers your own hooks. Adoption is idempotent — a worktree kobe already tracks (including ones kobe created itself) is a no-op. The `kobe hook worktree-created` callback never spawns the daemon and always exits 0, so a non-zero exit can't fail Claude's worktree creation. Per-task activity hooks now also backfill onto worktrees created before this version (installed on the next time the task is entered), so existing tasks light up too.
