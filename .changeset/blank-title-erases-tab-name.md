---
"@sma1lboy/kobe": patch
---

Fix a chattab showing its correct title for a moment and then falling back to "claude N". The live-title store seeded a freshly-attached PTY with an empty string, which reads as "this tab's title is empty" rather than "nothing reported yet" — so the host recorded that blank over the tab's real name and persisted it, leaving the tab wrong on the next start too. The store now reports `undefined` until a title arrives, and recording an empty title is a no-op.
