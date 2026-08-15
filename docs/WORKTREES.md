# Managing worktrees

The Worktrees page is a cross-project audit and cleanup tool for local git
worktrees. It helps you decide what has landed, what still carries local work,
and which working directories are safe to remove.

For the difference between a Task, Worktree, Terminal Tab and Split, start
with [Concepts](CONCEPTS.md). To create or adopt a task, see
[The TUI](TUI.md#creating-a-task).

## Open and navigate the page

1. Focus the task sidebar with `ctrl+q`.
2. Press `x`.
3. Use the up/down arrows to select a worktree.
4. Press `esc` or `q` to return to the workspace.

The page lists non-main worktrees from every saved **local** project. Remote
SSH projects are not included. It loads local git facts first, then fills in
remote and GitHub PR signals; a slow or unavailable network therefore leaves
useful local rows on screen.

## Read a worktree row

Each row shows its branch and absolute path. These badges are evidence, not an
automatic cleanup decision:

| Badge | Meaning |
|---|---|
| `rove` | The path is inside a recognized Rove-managed root. It does not by itself mean a Task currently points to it. |
| `dirty` | `git status --porcelain` found modified, staged, or untracked files. |
| `on remote` | A branch with this name exists on `origin`. |
| `not pushed` | No branch with this name exists on `origin`. |
| `remote unknown` | There is no reachable `origin`, or the remote check failed or timed out. |
| `PR open` | GitHub reports an open PR for the branch. |
| `merged (PR)` | GitHub reports a merged PR for the branch. |
| `in main` | The branch is zero commits ahead of the detected remote default branch. |
| `PR closed` | GitHub reports a closed, unmerged PR. |
| `stale` | No stronger signal exists and the last activity is more than 14 days old. |

The `rove` badge describes where the directory lives. **Adoption** describes
whether Rove has a Task for that worktree. Either a Rove-managed or external
worktree can be adopted through New task → Adopt Worktree or `rove adopt`.
Only an adopted/tracked worktree can use the page's Land action.

Remote and PR badges are advisory. They never bypass the dirty-worktree gate,
and `remote unknown` is not treated as permission to delete.

## Land a tracked branch

Landing merges the selected task branch into the branch currently checked out
in the project's base checkout.

1. Make sure the base checkout is on the branch you intend to receive the
   work and has no uncommitted or untracked files.
2. Select the worktree and press `l`.
3. Confirm the branch and base-checkout operation.

The page uses a normal `--no-ff` merge. If the selected directory is not
tracked by a Rove task, Land refuses. A dirty base checkout also refuses. On a
merge conflict, Rove aborts the merge and reports the conflicted paths, leaving
manual conflict resolution to you.

Landing does not remove the worktree, archive the task, or delete the source
branch. Those are separate lifecycle decisions.

## Remove a clean worktree

1. Select the worktree and press `d`.
2. Confirm **Delete worktree**.

The row disappears while removal runs. If git refuses or the operation fails,
the row returns. A successful removal deregisters and removes the working
directory but keeps its git branch.

For a worktree tracked by a Task, Rove clears that Task's worktree pointer. It
does not delete the Task, its branch, or engine history. Opening the Task later
may materialize a fresh worktree from the retained branch.

## Force-remove a dirty worktree

Dirty removal is deliberately two-stage:

1. Press `d` and confirm the ordinary deletion.
2. The daemon checks the worktree and refuses because it is dirty.
3. Rove opens a second **Force delete worktree?** confirmation naming the
   branch and warning that modified and untracked files will be permanently
   lost.
4. Confirm only after preserving anything you need.

The first confirmation can never silently turn into a force deletion. The
second confirmation is the boundary that authorizes data loss. The branch is
still retained, but uncommitted and untracked files are not recoverable from
that branch.

## Troubleshooting

- **Land says the worktree is not tracked.** Adopt it as a Task first, or
  merge the branch manually.
- **Land refuses a dirty base checkout.** Commit or stash changes in the base
  checkout, verify its current branch, then retry.
- **Land reports conflicts.** Rove has already aborted the merge. Resolve the
  branch relationship manually before retrying.
- **A removed row comes back.** The daemon operation failed or git still lists
  the worktree. Read the daemon log, correct locks or permissions, and retry.
- **Remote state says unknown.** Check `git remote -v`, network access and
  `gh auth status`; the local dirty and branch facts remain valid.
