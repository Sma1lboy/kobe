---
"@sma1lboy/kobe": patch
---

fix: the web diff viewer now shows the patch for files whose names have non-ASCII characters, spaces, or control characters. Git C-quotes those paths in `git diff` output (octal byte escapes like `"b/\303\274.txt"`) and appends a disambiguation tab to spaced names (`+++ b/a b.txt\t`), but the per-file patch splitter keyed on the raw marker text and used a weaker local unquoter, so the patch never matched the NUL-delimited porcelain path and the file rendered as changed with an empty diff. Path resolution now flows through the shared rigorous git-path unquoter and strips the disambiguation tab, so unicode, spaced, and special-char filenames join their hunks correctly.
