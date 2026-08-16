---
"@sma1lboy/rove": patch
---

Verify session identity before recording a dispatcher (issue #24)

`$ROVE_TASK_ID`/`$ROVE_TAB_ID` are ordinary environment variables, so any
detached descendant of an engine tab — a Claude Code background process, for
instance — keeps exporting that tab's ids indefinitely. Every task such a
process created recorded a dispatcher pointing at a stranger's session, which
is where finished workers sent their reports.

`add`, `send`, and the new-task coda now cross-check the env against the pty
host before believing it: the named tab must be alive AND its shell must be an
ancestor of the calling process. Unverified means no dispatcher, no
`[KOBE PEER]` provenance, and no spawner address in the worker's own
instructions — with an `identityWarning` on the verb's JSON result so the
degrade is visible rather than silent.
