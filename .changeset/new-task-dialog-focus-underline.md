---
"@sma1lboy/kobe": patch
---

New-task dialog focus styling. A focused field label (`repo`, `engine`, `from branch`, the clone fields…) is shown primary + bold + underline; unfocused labels stay muted. The active mode tab and selected engine keep their ▸ + bold + primary look (the active mode tab also underlines while the mode selector itself holds focus, and the `claude`/`codex` chips never underline). Input values are left at their default colour. This replaces the earlier accent-hue-on-focus, which read as jumpy.
