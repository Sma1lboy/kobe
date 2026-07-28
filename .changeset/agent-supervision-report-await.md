---
"@sma1lboy/kobe": patch
---

Agent-driven fan-out gets an honest completion contract: a worker files an explicit verdict with `kobe api report --outcome succeeded|failed` (stored verbatim on the task as `workerReport` — the worker's claim, never kobe-verified or inferred from prose/exit codes), and a coordinator blocks poll-free on `kobe api await --task-ids a,b,c` until every task settles or the timeout returns a `timedOut: true` checkpoint (exit 0 — silence never proves worker death). The agent skill (v6) now teaches both sides of the contract.
