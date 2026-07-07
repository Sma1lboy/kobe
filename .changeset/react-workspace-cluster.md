---
"@sma1lboy/kobe": patch
---

Ports the workspace cluster (three-column Sidebar | TerminalTabs | FileTree layout, split-pane terminal, tab strip, turn-status polling, files activity badge) to React under `src/tui-react/workspace/`, the final piece of the Solid→React migration (issue #16). React is now the default runtime for the native workspace, settings, help, history, and ops surfaces — set `KOBE_SOLID=1` to fall back to the legacy Solid host during the transition window. The worktree-management page overlay isn't ported yet and shows a placeholder until it lands.
