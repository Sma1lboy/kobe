---
"@sma1lboy/kobe": patch
---

Announce a background task that hits a rate limit: a non-selected task entering the rate-limited state now raises the same cross-task toast, chime, and desktop notification as an error, matching how the per-tab chip already surfaces it, so a rate-limited task no longer lands silently in the attention Inbox with no heads-up.
