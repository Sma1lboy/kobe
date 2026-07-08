---
"@sma1lboy/kobe": patch
---

fix: the daemon's pty-host sweep now resolves the pty socket from its own homeDir instead of the ambient environment. A daemon started against a non-default home (the test suite's temp-home daemons) used to sweep the REAL user pty-host with its own task list — a test's empty snapshot then killed every live engine session on the machine, on every full test run.
