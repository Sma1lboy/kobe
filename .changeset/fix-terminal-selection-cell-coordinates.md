---
"@sma1lboy/kobe": patch
---

Fix embedded-terminal copy selection around Chinese, emoji, and other wide glyphs: highlighting and clipboard extraction now map mouse columns by terminal-cell width, so selections no longer overpaint blank space or omit text at their boundaries.
