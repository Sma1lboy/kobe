---
"@sma1lboy/kobe": patch
---

The React TUI is now the default implementation for every surface (workspace, settings, help, history, ops, worktrees) — `KOBE_SOLID=1` keeps the retiring Solid implementation as an escape hatch, selected in one place (`uiFramework()` in env.ts). Fixes the silent exit-1 boot crash after the flip: the upstream @opentui/solid preload compiled the React files as Solid JSX; kobe now ships its own JSX loader rule (`scripts/jsx-plugin.ts`) — Solid transform everywhere except `src/tui-react/**`, whose per-file React pragmas are honored — shared by the dev preload, bunfig, and the production build.
