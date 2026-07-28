---
"@sma1lboy/kobe": patch
---

Tab auto-naming no longer adopts junk first prompts: a conversation opened with a menu answer like "1" or bare punctuation falls back to the vendor default ("claude 2") instead of naming the tab "1". Display-side guard, so already-persisted junk titles heal without a migration.
