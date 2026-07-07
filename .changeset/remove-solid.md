---
"@sma1lboy/kobe": patch
---

Remove the Solid.js TUI — React is now the only UI implementation. The `KOBE_SOLID=1` escape hatch back to the Solid host is gone, and the build/test toolchain no longer registers a Solid JSX transform (React JSX is handled by `@opentui/react`'s per-file pragmas). The tmux-era Solid-only surfaces (`quick-task` / `new-task` window / `update-page` / `tasks-pane`) are retired.
