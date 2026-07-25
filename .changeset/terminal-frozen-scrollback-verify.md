---
"@sma1lboy/kobe": patch
---

Terminal panes no longer re-verify frozen scrollback on every refresh. Engines that emit synchronized-output frames (DECSET 2026 — both Claude Code and Codex do) force a full-window dirty mark, which made the redraw-dedupe check walk the entire scrollback before reaching the viewport rows that actually changed. It now skips rows the rebuild path already cached under an absolute line id, cutting a streaming redraw from 0.94ms to 0.46ms at the default 1000-row scrollback.
