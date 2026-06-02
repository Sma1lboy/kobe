---
"@sma1lboy/kobe": minor
---

File tree: `e` opens the highlighted file in your editor. `enter` stays the read-only preview/diff; the new `e` key opens the file in a fresh tmux window running your editor, and the window closes back to kobe when you quit it. Pick the editor under Settings → General → Editor: `vim`, `nano`, or a `custom` command (e.g. `code -w`, `subl -w`, `emacsclient`; use `{file}` to place the path, otherwise it's appended). An empty custom command falls back to `$VISUAL`/`$EDITOR`. If the chosen editor isn't installed, `e` falls back to the preview so it's never a dead key. The file pane footer shows `↵ preview · e edit`, and the editor opens in a tmux window named after the editor (`vim` / `nano` / `code` …) so you can see at a glance which one launched.
