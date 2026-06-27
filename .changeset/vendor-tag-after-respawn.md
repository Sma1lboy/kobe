---
"@sma1lboy/kobe": patch
---

Only advance the session's `@kobe_vendor` tmux tag after every window's engine pane respawns cleanly during a vendor switch. Previously a partial failure (some window's `respawn-pane` erroring) still moved the tag to the new vendor, so the failed window kept running the old engine while its Ops pane polled the wrong vendor's transcript and did wrong turn detection. The in-place respawn now reports an aggregate success/failure; on failure the prior tag is left untouched (the next `ensureSession` retries) instead of falsely claiming the switch — and the session is never killed+rebuilt, so sibling chat tabs survive.
