---
"@sma1lboy/kobe": patch
---

Paste reaches the embedded engine CLI (issue #16): opentui's parsed paste events forward to the PTY, and the Bun backend re-wraps them in bracketed-paste markers exactly when the embedded app negotiated DECSET 2004 — a multiline prompt pasted into claude lands as one paste instead of executing line by line.
