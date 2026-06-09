---
"@sma1lboy/kobe": patch
---

Customizable keybindings via `~/.kobe/settings/keybindings.yaml`. Override any rebindable chord per binding id (`chat.fork.new: ctrl+g`), with `darwin:` / `linux:` platform overlays and `null` to unbind; overrides apply to every kobe pane at launch, and the help dialog (F1) / status bar advertise the new chords automatically. Invalid or unsafe overrides (unknown ids, bare letters on global scope, `shift+letter` chords) are rejected with warnings instead of breaking input. The Tasks pane's f1/n/s/u/o/b/v verbs now route through the central keymap, so they follow overrides too. A new read-only Settings → Keybindings section shows the config path, applied overrides, and every load warning. Direction-multiplexed bindings (j/k navigation, `[`/`]` cyclers, ctrl+hjkl pane focus) and tmux-layer session keys stay fixed for now.
