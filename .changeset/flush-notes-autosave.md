---
"@sma1lboy/kobe": patch
---

Stop the web Notes panel from losing the last edits when you switch tasks or close the panel: an autosave still pending inside the 600ms debounce window is now flushed to the task it belongs to instead of being cancelled, so edits typed just before navigating away are no longer silently dropped.
