---
"@sma1lboy/kobe": patch
---

New-task dialog focus is now shown with an underline in the element's own colour instead of switching to the accent hue, which read as jumpy. Field labels (incl. `engine`) stay muted and gain an underline when their field/selector is focused. The active mode tab and the selected engine are marked by weight + colour (▸ + bold + primary) rather than an underline — the engine row's focus is carried by its label, so the `claude`/`codex` chips never underline. The focused field's input value (repo, branch, clone fields) is tinted primary so the value you're editing matches the selected mode tab / engine.
