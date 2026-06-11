---
"@sma1lboy/kobe": patch
---

The web dashboard's engine prompt composer gains shell-like history: press ↑ to recall previously-sent prompts (newest first) and ↓ to walk back toward your in-progress draft. History is per-task and persists across reloads (localStorage). ↑/↓ only enter history when the caret is at the edge of the draft, so they still move within a multi-line prompt; once you're browsing, they keep walking the ring, and Escape exits history and restores your in-progress draft.
