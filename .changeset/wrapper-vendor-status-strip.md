---
"@sma1lboy/kobe": patch
---

Tabs pinned to a user's engine wrapper keep wearing the engine's status glyph no more. A wrapper like `claudecpa` (a zsh function that ends up running real claude) registers as a custom engine, which declares no glyph vocabulary — so the per-vendor lookup found nothing and the prefix survived. A vendor with no vocabulary of its own now falls back to the union of every built-in's glyphs, and cleaning is no longer gated on the engine claiming its title, since a status glyph is not part of a name whoever wrote it.
