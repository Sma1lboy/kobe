---
"@sma1lboy/kobe": patch
---

Fixes from a third release-gate review of the stream's newer changes: the markdown renderer no longer rewrites markdown inside `code` spans or pairs `*`/`[` across a code boundary (it now splits on code spans and transforms only the non-code parts), renders bold that contains italic (`**bold *x* more**`), and drops protocol-relative `//host` links to inert text per its "relative only" contract. The `j`/`k`/arrow task-rail nav no longer swallows arrow-scroll on a focused transcript/diff pane (arrows only navigate when the rail or nothing owns focus) and is suppressed while the Settings overlay is open. "Reset layout" navigates home so the deep-link route can't instantly re-select the cleared task. And the notes panel clears its buffer + drops to Edit mode on a task switch so the previous task's content can't flash during the async reload.
