---
"@sma1lboy/kobe": patch
---

`kobe api read-output --source terminal` no longer returns an empty tail when the last line of output is larger than the 64 KB byte cap. The tail's byte-budget loop counted the final line first, so a single over-budget line (a minified dump, a long base64 blob, a giant log line with no newline) pushed the window start past the end and blanked the whole response — a coordinator agent reading the pane got nothing. The tail now always keeps at least the last line, mirroring the structured-history page's "never fewer than one" floor, while older lines are still trimmed to fit the cap.
