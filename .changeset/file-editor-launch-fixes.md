---
"@sma1lboy/kobe": patch
---

File-tree editor (`e`) follow-up fixes:

- **Custom command was un-typeable on the standalone Settings page** — the dialog's `j/k/l/h/t` navigation kept firing under the open text input and swallowed those letters (you couldn't type the `l` in `{file}`). The dialog now suspends its own key bindings while a sub-dialog is open.
- **A custom command typed while the kind was still `vim` was silently ignored** — setting a non-empty custom command now auto-switches the editor kind to `custom` so it actually takes effect.
- **The editor kind row was unlabelled** (`< vim >`), easy to miss above the custom-command row — it now reads `editor: < vim >  (enter to change)`.
- **The standalone Settings page jumbled its text** when the content was taller than the window — the page now scrolls instead of compressing the rows.
- The editor opens in a tmux window named after the **file** being edited (matching the preview window) so several open files are easy to tell apart.
