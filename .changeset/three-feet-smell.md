---
"@sma1lboy/rove": patch
---

Answering a question clears the tab's `?` badge. Approving a permission prompt ends the turn, so `Stop` arrives and the badge clears — but answering an AskUserQuestion dialog resumes the same turn, so the engine emits nothing at all while `permission_needed` is deliberately sticky (the lapse watchdog must never idle a task that needs a human). Nothing cleared it, and the badge pinned forever on a tab whose engine was already working again. The enter typed at a waiting tab is now recorded as evidence that the answer happened, and suppresses that stale state until the daemon reports something newer. Scoped to the answered tab and to `permission_needed` alone, so a sibling's prompt or a real error badge is never hidden.
