---
"@sma1lboy/kobe": patch
---

The kobe skill now teaches "inside a kobe session, kobe verbs come first" (v7). An agent that finds `$KOBE_TASK_ID` set is a session kobe manages, and delegation or parallel work should route through `fan-out` / `add --prompt` / `send` / `await` / `dispatch` rather than hand-rolled subagents or a raw `claude -p` — work in a kobe task gets its own worktree, a visible sidebar row, lifecycle tracking, and an explicit outcome contract, which ad-hoc subprocesses never do. In-context subagents stay fine for read-only research; the boundary is work. The injected worktree protocol gains one pointer line naming those verbs and where to learn them (`kobe api schema` / the skill) — a pointer, not a curriculum, so per-session context cost stays flat.
