---
"@sma1lboy/kobe": patch
---

React ports of the task dialogs (issue #15, G3 wave 2): the full NewTaskDialog (Existing / New Repo / Adopt tabs, engine selector, saved/browse repo picker, branch picker, async clone) and RenameTaskDialog under `src/tui-react/component/`, driven by the shared framework-free `state.ts`/`clone.ts` helpers, with a `dev:mock-react-dialogs` live-render host.
