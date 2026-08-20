---
"@sma1lboy/rove": patch
---

Task ids stay strictly sortable when the wall clock steps backward: the ULID generator now holds its last timestamp (instead of regressing the sortable prefix) and increments the random tail whenever an incoming timestamp does not advance past the previous one, so an NTP correction, VM resume, or manual clock change mid-session can no longer mint a task id that sorts before its predecessor and silently reorder the task index. Same-millisecond monotonicity and forward-clock behavior are unchanged.
