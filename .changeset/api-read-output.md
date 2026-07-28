---
"@sma1lboy/kobe": patch
---

feat: `kobe api read-output` — structured, cursor-paged read of a task's engine session output. Auto-selects the engine adapter's own transcript history (bounded pages, deterministic pagination, opaque source-pinned cursors, no transcript-path leakage) and falls back to a bounded terminal tail with a typed `fallbackReason` (`engine_unsupported` / `history_missing` / `history_unreadable`); a changed session or process incarnation returns a typed `SOURCE_CHANGED` error instead of silently switching. Backed by a new read-only `pty.peek` host verb that snapshots a session's ring buffer without attaching, spawning, or resizing.
