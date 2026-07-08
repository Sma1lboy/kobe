---
"@sma1lboy/kobe": patch
---

fix: the daemon socket client left post-connect socket errors unhandled — an EPIPE while writing to a peer that was mid-exit (the pty-host sweep race) crashed the process instead of rejecting the pending request. Errors now route through the close path so callers' own catch blocks handle them.
