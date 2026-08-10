---
"@sma1lboy/kobe": patch
---

feat: `kobe api inspect` — production diagnostics in one read

New read-only verb aggregating every identity/activity signal an investigation needs: the daemon's RAW activity registry via a new `debug.inspect` RPC (per-task/per-tab state, the vendor the liveness probe asks about, whether a lapse watchdog is armed), the pty-host inventory joined with a live process-tree engine walk per session (tri-state `foreground`: engine / confirmed-none / unknown — the exact walk the TUI's live-engine store runs, so CLI output and TUI behavior compare 1:1), and the persisted `terminalTabs.*` snapshots the sidebar names its rows from (`liveVendor` / `lastTitle` / `autoTitle`). Offline and non-spawning: a missing daemon or PTY host degrades its section to null instead of erroring — safe to run against a live production kobe, which is the point.
