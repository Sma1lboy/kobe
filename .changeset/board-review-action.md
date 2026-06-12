---
"@sma1lboy/kobe": patch
---

**One-click review from the board** — `In review` cards grow a clipboard button that pastes a review instruction straight into the task's engine session (spawning it if it isn't running — output lands in scrollback, peek to watch). The instruction tells the agent to inspect the changes, run the relevant checks, and on a PASSING review run `kobe api set-status … --status done`; on a failing one, report findings and leave the status alone. The `done` authorization travels with the click — the always-on status protocol still only ever lets an agent self-report `in_review`, so a session that was never asked to review can never reach `done` by itself. Ships a new PTY-sidecar endpoint (`POST /pty/send`, same localhost-origin policy as the WS attach) that any future board quick-action can reuse.
