---
"@sma1lboy/kobe": patch
---

The web dashboard Settings page now matches the TUI settings surface much more closely: it has section navigation, shared TUI appearance controls, editable engine launch commands and custom engines, board quick-action templates, experimental Dev toggles, browser notifications, and connection/version diagnostics. A new bridge-local `/api/settings` route reads and writes the shared `state.json` preferences through the same atomic state-store path as the TUI, so web and TUI changes stay aligned. Web new-task creation and Issues quick start now follow the shared default engine setting instead of silently falling back to the first detected engine or the daemon's Claude default. Issues quick start also materializes the task worktree and syncs the source checkout's `docs/issues.json` into it before pasting the prompt, so a newly-created issue exists inside the agent's worktree instead of only as an uncommitted change in the source checkout.
