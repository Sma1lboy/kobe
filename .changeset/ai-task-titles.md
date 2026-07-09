---
"@sma1lboy/kobe": patch
---

Task auto-naming now uses a Claude Code-style two-step flow: kobe applies a fast first-prompt fallback immediately, then asks the active engine for a concise AI title and swaps it in when available without overwriting user renames.
