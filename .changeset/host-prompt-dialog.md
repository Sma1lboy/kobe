---
"@sma1lboy/kobe": patch
---

Host-provided plugin input dialog: `kobe api prompt --title "…"` blocks until an attached TUI answers through the standard input dialog (`ui.prompt` channel → dialog → `ui.promptReply`; first answer wins, 120s default timeout). Plugins get consistent input UX instead of hand-rolled in-pane prompts.
