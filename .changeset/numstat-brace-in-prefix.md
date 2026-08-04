---
"@sma1lboy/kobe": patch
---

Fix a renamed file losing its +/- line counts in the file tree and sidebar change chip when a directory in its unchanged path prefix is named with a literal `{` (e.g. renaming inside `a{b/`): git's `--numstat` brace-compacts such a rename to `a{b/{old.txt => new.txt}`, and the shared parser anchored on the FIRST `{`, so it grabbed the prefix's brace and resolved the path to `anew.txt` — which no longer matched the porcelain status row, orphaning the counts. It now anchors on the ` => ` separator and takes the braces that wrap it, so the path resolves correctly and the numstat counts key back onto their status row.
