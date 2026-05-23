# @sma1lboy/kobe-ops

Companion CLI shipped alongside [`@sma1lboy/kobe`](../kobe). Lives inside
the right-hand "Ops" pane of a kobe-managed tmux session, next to the
interactive claude session.

v0.6.0 scope (KOB-229) — **file watcher**:
- Live `git status -sb` + worktree tree (depth 2)
- Refreshes when files change (1s polling fallback when `fs.watch`
  isn't reliable, e.g. on case-sensitive bind mounts)
- `q` quits the pane (tmux closes it)
- `r` forces a refresh

0.6.x will layer on the "ops menu" — quick-fork, create-PR (`tmux
send-keys` injection into the claude pane), and a file-preview view
mode. The full plan lives in [`KOB-229`](https://linear.app/codesfox/issue/KOB-229)
and [`KOB-232`](https://linear.app/codesfox/issue/KOB-232).

## Usage

`kobe-ops` is normally invoked by `@sma1lboy/kobe`'s
`ensureSession` when it builds the three-pane tmux layout. You can
also run it directly:

```sh
bunx @sma1lboy/kobe-ops --task-id <id> --worktree <path>
```

Required arguments:
- `--task-id <id>` — stable kobe task id (informational; surfaced in the header)
- `--worktree <path>` — absolute path to the task's git worktree (the watcher reads / `cd`s here)

Optional:
- `--target-pane <selector>` — tmux pane selector for `send-keys` (`=kobe-<id>:0.0` by default).
  v0.6.0 doesn't use send-keys yet; the flag is reserved for the
  0.6.x ops menu so the wire shape stays stable.

## Status

Pre-release — pinned to kobe's 0.6 cycle. API may change.
