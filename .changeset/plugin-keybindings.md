---
"@sma1lboy/kobe": patch
---

Plugin keybindings: a `plugins:` section in `~/.kobe/settings/keybindings.yaml` binds user-chosen chords to plugin panes or actions (`ctrl+g: pane:examples.lazygit.git`, `f6: action:examples.notify.test`), with platform overlays and live reload. No default chords ship; chords fire a detached `kobe plugin` invocation, and `kobe plugin pane open` now also accepts a positional `<plugin-id>.<pane-id>`.
