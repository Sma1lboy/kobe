---
"@sma1lboy/kobe": patch
---

Tab names no longer carry the engine's own status glyph. Claude writes `✳` into its OSC title at rest and cycles `⠂`/`⠐` during a turn; codex prefixes a spinner frame. Kobe already draws turn state in its own glyph column, so the prefix said the same thing twice — and the animated variants made a resting tab look busy. The glyph vocabulary is declared per engine (`terminalTitle.statusPrefixes`), stripped where the raw title enters the app, and a prefix that would consume the whole title is left alone so a session genuinely named that keeps its name.
