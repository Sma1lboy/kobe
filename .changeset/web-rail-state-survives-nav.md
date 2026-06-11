---
"@sma1lboy/kobe": patch
---

The web dashboard's task-rail filter state (text query, status chip, sort, archived toggle) now survives opening a task from the home route — previously the first `/` → task navigation remounted the rail and silently reset every filter, defeating the triage UI on its most common trigger. The state lives in an in-memory store: it persists across route navigation but deliberately resets on a full page reload, and the TUI's sort preference now syncs on a rising edge so a pref replay no longer stomps a local web-side sort toggle.
