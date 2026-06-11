---
"@sma1lboy/kobe": patch
---

Harden the notes markdown renderer against a quadratic-time stall: a single line with a long run of unmatched `[` could make the link regex backtrack for seconds. The renderer now skips the link pass when a line has no `]`/`(` to match — pathological input renders instantly, real links are unaffected. (A focused adversarial XSS review confirmed the renderer has no injection bypass; this was the only finding.)
