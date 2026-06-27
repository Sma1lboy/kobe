---
"@sma1lboy/kobe": patch
---

Distinguish a `gh`/transport failure from a genuine "no PR yet" in the daemon's PR-status poller. A non-success `gh pr view` is now classified into a typed error (`missing-binary` / `auth` / `timeout` / `network` / `parse` / `no-remote`) versus a real `empty` result, instead of both collapsing to "no PR": an error keeps the last-known chip (a transient blip never clobbers a good status) and logs *why* it's stale so it's diagnosable. Consecutive transport failures now back off exponentially (capped) so a persistently broken `gh` (e.g. not installed) stops re-spawning every tick, a deterministic "no GitHub remote" settles to a long idle cadence, and every scheduled poll is jittered so N tasks coming due together (after a network reconnect) no longer poll in lockstep. Best-effort and non-throwing throughout — a PR-status failure still never crashes the daemon or blocks other collectors.
