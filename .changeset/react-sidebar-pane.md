---
"@sma1lboy/kobe": patch
---

React port of the sidebar pane behind the G3 migration track (issue #15): `src/tui-react/panes/sidebar/` mirrors the Solid Sidebar (views, `/`-search, project filter, move mode, cursor policy, hover tooltip, row cards) on the React runtime, with the framework-free view logic extracted to `src/tui/panes/sidebar/view-core.ts` and consumed by both renderers. New `dev:mock-react-sidebar` smoke host renders the port against shared synthetic task fixtures. No behavior change for the shipped Solid TUI.
