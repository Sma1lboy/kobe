---
"@sma1lboy/kobe": patch
---

Tie the TUI's loose timers and async fetches to their component lifecycle so nothing fires after unmount. Toast auto-dismiss (`NotificationsProvider`) and the dialog's deferred refocus were fire-and-forget `setTimeout`s that could run against a torn-down signal or a destroyed renderable; both now go through a new owner-scoped `createManagedTimeouts` helper that clears any pending timer on cleanup. The file-tree pane's tab/refresh and worktree-change refetches now carry an `AbortController` that is aborted on the next run or on cleanup, threaded through `runWorktreeGit` so a rapid tab-switch or repeated refresh actually kills the in-flight `git` subprocess instead of stacking overlapping reads.
