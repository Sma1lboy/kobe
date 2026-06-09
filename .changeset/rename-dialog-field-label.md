---
"@sma1lboy/kobe": patch
---

**Single-field dialogs now label their field correctly instead of always saying "title".** The reusable text-input dialog hard-coded its field label as `title` and its footer as `enter rename`, so every place that reused it — editing an engine's launch command, an engine display name, the custom editor command, the feedback body, renaming a branch, the new-engine flow — confusingly read "title". The dialog now takes a per-use `fieldLabel` / `submitLabel`, so the engine command edit reads `command`, the branch rename reads `branch`, the feedback body reads `body`, and so on. Genuine task renames still read `title`. Edits that mean "blank = default" (engine command/name, custom editor command) can now actually be cleared by submitting an empty value.
