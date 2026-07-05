---
"@sma1lboy/kobe": patch
---

Fix the git numstat parser doubling a path separator when a rename adds or drops a directory level. Moving a file up out of a subdirectory (or down into one) makes git empty one side of its brace-compacted rename — `src/{sub => }/a.txt` — and the parser rejoined it as `src//a.txt`, so its +/- line counts no longer key-matched the `src/a.txt` the status row reports and the file-tree / sidebar change chips lost the counts for that file. The seam now collapses, so directory-level renames resolve to one canonical path across both git formats.
