---
"@sma1lboy/rove": patch
---

Sidebar tab rows now show each session's live title, not the one recorded the last time you opened that task. The title is read from the pty host's OSC observation — which runs whether or not anything is attached — and goes through the same status-prefix strip as before, so a row still shows the conversation name beside kobe's own state glyph rather than the engine's spinner frame.
