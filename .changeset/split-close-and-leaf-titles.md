---
"@sma1lboy/kobe": patch
---

Fix ctrl+w/F2 not reaching split leaves, and split leaf-1's corner tag freezing on "zsh".

While a workspace tab was split, ctrl+w and F2 were always captured by the tab-level close/rename bindings (React mounts ancestors on top of the keymap stack, inverting the Solid-era precedence), so a split leaf could never be closed or renamed — on a single tab ctrl+w just toasted "cannot close last tab". The tab-level entries now gate themselves off while the active tab is split. Also, a shell tab's own leaf (leaf-1) now tracks its live foreground-process title, so entering claude/vim from the shell updates the split corner tag instead of freezing on "zsh"; engine tabs keep their conversation title.
