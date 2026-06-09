---
"@sma1lboy/kobe": patch
---

**Removed the clickable `+ New task` footer from the task sidebar.** kobe is keyboard-first, and the same create-task action was already surfaced by the `n` chord and the ShortcutHints legend — the footer was the only mouse-style button in the rail and pure duplication. Creating a task is now `n` (or `prefix F`); the dead `onAddTask` sidebar prop and its wiring are gone too.
