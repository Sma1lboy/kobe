---
"@sma1lboy/kobe": patch
---

Embedded terminals no longer leak the outer emulator's identity to child applications, preventing terminal-specific escape sequences from being selected for the wrong parser.
