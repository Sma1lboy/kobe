---
"@sma1lboy/rove": patch
---

Fix a pty-host blip resurrecting an already-corrected idle tab as a phantom `running` dot. Once observation disproves a stale hook `running` (ESC interrupt, dead engine), the hook slot is now retired instead of left to win the next ungated arbitration — and its lapse watchdog no longer keeps re-arming that claim for the length of a host outage.
