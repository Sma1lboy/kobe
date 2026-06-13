---
"@sma1lboy/kobe": patch
---

The web dashboard Settings page now matches the TUI settings surface much more closely: it has section navigation, shared TUI appearance controls, editable engine launch commands and custom engines, board quick-action templates, experimental Dev toggles, browser notifications, and connection/version diagnostics. A new bridge-local `/api/settings` route reads and writes the shared `state.json` preferences through the same atomic state-store path as the TUI, so web and TUI changes stay aligned.
