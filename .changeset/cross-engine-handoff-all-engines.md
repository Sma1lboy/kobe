---
"@sma1lboy/kobe": patch
---

feat: cross-engine handoff now works FROM every built-in engine, not just claude/codex. Copilot's refusal was stale — each session dir already holds the `events.jsonl` the reader parses, so it just needed naming. Kimi gets a path-only reader (`session_index.jsonl` → `agents/main/wire.jsonl`): it still parses no messages, but a handoff hands over a path, not a transcript, so that's all it ever needed — and it lights kimi's activity badge as a side effect. Only custom engines are still refused, since Rove can't know their store.
