---
"@sma1lboy/kobe": patch
---

The engine's status glyph stops leaking into recorded tab names. Stripping it was gated on knowing which engine wrote the title, but that answer comes from a ~2s process-tree walk — so on every tick the probe had not answered yet, a raw `✳ …` passed through and was recorded as the tab's name, which is why the prefix kept reappearing. The vendor now only narrows which glyphs to look for; an unknown or not-yet-probed vendor falls back to every built-in's glyphs and still strips.
