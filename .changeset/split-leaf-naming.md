---
"@sma1lboy/kobe": patch
---

Split naming semantics fixed: the whole tab is the "group" (default tab title is now `group {n}`), and each split pane carries its own corner-tag name — default is the basename of what it runs ("claude", "zsh", with a suffix for duplicates), and `F2` while split renames the active pane (falling through to rename-tab when unsplit, same contextual shape as `ctrl+w`). Previously every pane was mislabeled `group {n}`.
