---
"@sma1lboy/kobe": patch
---

The Tasks sidebar key legend is now a tight, curated set of ten rows instead of the long list that overflowed the pane. The footer now shows only the high-traffic chords — full help (F1), new task (n), settings (s), open (enter), focus engine (→), open wt (o), delete (d), views ([/]), move panes (⌃hjkl), and tasks→detach (⌃Q). The rows it dropped (sort, move/merge, un·archive, name/branch/engine, and the per-tab tmux chords for switch/new/engine/rename/close) are all still reachable from the F1 full-help dialog. Each row stays keymap-derived, so user overrides and unbinds in keybindings.yaml are still reflected and a live reload re-renders the legend.
