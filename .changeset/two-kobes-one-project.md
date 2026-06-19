---
"@sma1lboy/kobe": patch
---

The Tasks pane now shows only one PROJECTS row for a saved repo even if older state contains duplicate `main` task records, and `ensureMainTask` now dedupes repo-root, subdirectory, symlink-resolved, and trailing-slash variants before creating a new project row.
