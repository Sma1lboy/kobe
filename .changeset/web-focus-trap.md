---
"@sma1lboy/kobe": patch
---

Accessibility: the dashboard's modals (command palette, New Task, Adopt, confirm dialogs, keyboard help) now trap Tab focus inside the dialog and restore focus to whatever was focused when the modal closes, so keyboard users can't tab out into the page behind an open dialog. A shared `useFocusTrap` hook adds the trap + restore without disturbing each modal's own initial-focus behavior.
