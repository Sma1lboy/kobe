---
"@sma1lboy/kobe": patch
---

Fix the embedded terminal freezing on the last frame during rapid redraws: the snapshot pass skips half-painted frames while a synchronized-output block is open, but under back-to-back redraws a new block could open before the closing write's refresh landed, so the skip never got a follow-up and the screen stopped updating. The skip now reschedules itself.
