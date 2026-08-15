---
"@sma1lboy/rove": patch
---

Sidebar state glyphs no longer overrun their cell on common terminal fonts.

kobe reserves one cell per state glyph, but a codepoint the terminal's font lacks gets substituted by the OS at ITS advance — and a CJK or dingbat substitute is 1.1–1.6 cells wide, so it bleeds into the label beside it. `◌` (the tab row's "unknown" state) is absent from FiraCode Nerd Font and SF Mono, so macOS drew it from HiraginoSans at 1.62 cells, sitting on the first letter of every tab name.

- The tab row's separate `◌ unknown` state is gone. A tab the daemon hasn't observed rests at the same dim `·` a non-agent tab wears — both readings sent you into the tab to find out, so the distinction cost a column and bought nothing.
- Error / failed-deletion is `×` (Latin-1) instead of `✕` (dingbat block, 1.24 cells via ZapfDingbats).
- The Inbox's rate-limited badge is `◷`, matching the sidebar, instead of `⌛` — U+231B is an emoji codepoint, so it resolved to a 2.13-cell colour glyph.
- Claude Code's brand spinner is removed; every engine animates with the braille set. Its frames fell back to ZapfDingbats at five different advances (1.11–1.28 cells), so a running row jittered at 10Hz. Braille falls back as one face at one width. This also retires the per-engine `spinnerFrames` registry field, which had exactly one implementation.

A test now pins the glyph vocabulary to an allowlist, so a future glyph has to be checked against real fonts before it can render.
