---
"@sma1lboy/kobe": patch
---

Uppercase letters are now distinct bindable chords: a shifted keypress matches `shift+<letter>` first and falls back to the bare letter, so `Z` can be bound apart from `z`. Keybinding YAML accepts `shift+p` or the bare-uppercase sugar `P`; `sidebar.goto` / `sidebar.pin` / `sidebar.localMerge` now carry explicit shift chords and become user-rebindable. Shift combined with other modifiers on a letter (`ctrl+shift+p`) stays rejected — legacy terminals send the same byte with and without shift.
