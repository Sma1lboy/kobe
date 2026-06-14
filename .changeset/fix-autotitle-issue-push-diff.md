---
"@sma1lboy/kobe": patch
---

Final audit fixes:

- **Auto-title no longer names a task after slash-command boilerplate.** When a Claude session's first action was a slash/bash command (`/clear`, `/model`, `!cmd`), Claude writes an injected caveat and a `<command-name>` breadcrumb before the real prompt, and kobe titled the task from that boilerplate. Those injected rows are now filtered out (mirroring Claude Code's own human-turn filter), so the title comes from the user's actual first prompt.
- **Issues board no longer flickers a stale state.** An unrelated repo's live issue push could briefly re-apply this repo's older snapshot over a just-fetched newer one; a push is now skipped when its snapshot hasn't actually changed.
- **Diff gutter line numbers.** A zero-length line inside a hunk is treated as a separator instead of a context line, so it can't offset every following line's number.
