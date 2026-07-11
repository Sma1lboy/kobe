---
"@sma1lboy/kobe": patch
---

Remove dead code: delete the legacy `kobe-web/server` standalone bridge (superseded by the daemon-hosted web transport, ADR 0003) and its three server-only tests, and drop three orchestrator dead spots — the voided `EMPTY_INDEX`, the unused `toTaskId` keep-alive in `core.ts`, and the `TaskIndexStore.archive` semantic-trap wrapper (production archiving goes through `orchestrator.setArchived`).
