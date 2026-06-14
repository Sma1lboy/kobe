---
"@sma1lboy/kobe": patch
---

Fix an "Invalid hook call" error that broke the web dashboard's kanban board: the monorepo carries two React versions (the web app pins ^19.2, the branding package pins 19.0), and `@dnd-kit`'s loose `react >=16.8` peer let the board's drag hooks resolve the second copy, so `useSortable` ran against a different React dispatcher. The web build now dedupes `react`/`react-dom` to a single copy, so the board's drag-and-drop renders cleanly.
