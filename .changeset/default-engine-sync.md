---
"@sma1lboy/kobe": patch
---

**Picking an engine with Ctrl+Shift+T now sets your default engine, and Settings shows it.** Choosing an engine for a new chat tab (Ctrl+Shift+T / `prefix T`) used to leave the default for *new tasks* untouched; it now updates the one shared "default engine" reference (`lastSelectedVendor`) that the new-task dialog and quick-task already read. Settings → Engines surfaces that reference: the default engine's row is marked with a `●`, and pressing `d` on any engine row sets it as the default — so the same default is visible and settable from Settings or from Ctrl+Shift+T, kept in sync.
