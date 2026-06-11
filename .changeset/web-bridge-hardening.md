---
"@sma1lboy/kobe": patch
---

Web bridge hardening and lifecycle correctness: `POST /api/rpc` now forwards only an explicit allowlist of daemon verbs (a new daemon verb is no longer browser-reachable until deliberately exposed; connection-scoped and hook-ingest verbs are pinned out by a contract test); a web archive/delete tears down the task's tmux session after the RPC commits — the same orphaned-engine bug `kobe api delete` had, where the engine kept running invisibly — matching the TUI semantics (delete always kills, archive kills only when archiving); and a task deleted from ANY surface (TUI, api, another browser) now sweeps this browser's workspace tabs and kills their sidecar PTYs, so a deleted task's web engine processes don't keep running either.
