---
"@sma1lboy/kobe": patch
---

**Opt-in auto in-review** — set `"autoInReview": true` in `~/.kobe/state.json` (live-read, no daemon restart) and the daemon advances a task `in_progress → in_review` when its engine finishes a turn that looks done: a free heuristic gate first (dirty worktree or an open PR), then a one-shot `claude -p --model claude-haiku-4-5` judge (override via `KOBE_JUDGE_MODEL`) classifies the agent's final message as "work complete" vs "mid-task / asking the user". Strictly one-way and conservative: never auto-`done`/`canceled`, a manual status change during the judge call wins, and any judge failure skips rather than moves. Works for every engine — the judge reads the vendor-neutral session history.
