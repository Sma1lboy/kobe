---
"@sma1lboy/kobe": patch
---

Web tasks are deep-linkable: selecting a task pushes `/task/<id>`, so a task URL can be shared/bookmarked/refreshed and browser back/forward walks your task-switch history. Visiting a task URL selects that task (and sets it active daemon-wide); archive/delete navigate back to the root, and a link to a since-deleted task falls back to the empty workspace once the snapshot proves it gone.
