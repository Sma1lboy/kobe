---
"@sma1lboy/kobe": patch
---

perf: the embedded terminal's refresh now reuses converted scrollback rows instead of re-converting the full 200-row margin on every frame — scrollback lines are frozen once they leave the live grid, so per-refresh conversion work drops to roughly the visible grid while an engine streams.
