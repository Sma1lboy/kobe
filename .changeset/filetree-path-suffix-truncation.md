---
"@sma1lboy/kobe": patch
---

fix: Changes-tab paths now truncate from the head so the filename (suffix) always survives — the path budget was computed from the full terminal width instead of the narrow files-pane width, so long paths right-clipped and showed only the leading directories.
