---
"@sma1lboy/rove": patch
---

Automation precheck output no longer garbles non-ASCII text into `�`: a `gh pr list` or `git log` precheck whose stdout carries CJK or emoji is now decoded as one UTF-8 stream instead of chunk-by-chunk, so the stdout/stderr captured with a skipped run reads cleanly and the tail cap keeps whole code points instead of halving a surrogate pair at the cut.
