---
"@sma1lboy/kobe": patch
---

G2 of the React TUI migration (issue #15): the full infrastructure layer — theme, focus, dialog stack, key-bindings dispatch, and i18n — now has React counterparts under src/tui-react/, sharing framework-free cores (theme-core, i18n lookup, keymap-dispatch) with the Solid originals so the two cannot drift. The dev:mock-react pilot mounts the whole provider stack end-to-end.
