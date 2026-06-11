---
"@sma1lboy/kobe": patch
---

Internal: the localStorage tab-kind migration (retired `notes` → empty chooser, legacy `chat` → `vendor`, unknown → `vendor`) is extracted to a pure `migrateStoredTab` and covered by tests, so stale browser state from an older build can't render an unknown tab or crash the SPA on load. 65 web tests now.
