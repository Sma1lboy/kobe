---
"@sma1lboy/kobe": patch
---

**Opt-in auto status flow** — flip on `Auto status flow` (Settings → Dev → Experimental, i.e. `experimental.autoStatus` in state.json, live-read) and the board starts moving itself: when an engine begins a turn on a `backlog` task the daemon advances it to `in_progress` (a pure rule — starting work is unambiguous), and every claude session kobe spawns gets its task id baked into the system prompt via `--append-system-prompt` with the instruction to run `kobe api edit set-status --task-id <id> --status in_review` once the work is genuinely done — the agent is the one party that knows whether its turn ended "complete" or "asking you a question". Strictly one-way: only `backlog → in_progress` and agent-reported `in_review`; `done`/`canceled` stay yours, and cards you place manually are never touched. Injection applies to newly spawned sessions; codex sessions move by hand until that adapter grows an injection point.
