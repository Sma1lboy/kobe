---
"@sma1lboy/kobe": patch
---

Fix the very first `kobe api` command on a fresh KOBE_HOME failing: the daemon spawn lock's `openSync(wx)` threw ENOENT when `.kobe/` didn't exist yet, which the held-lock fallback misread as "someone else is spawning" — a 15s stall ending in BAD_DAEMON. The lock now creates its parent directory first.
