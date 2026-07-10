---
"@sma1lboy/kobe": patch
---

Reattaching to a hosted terminal session no longer re-answers the child's past terminal queries. The ring-buffer replay contains DSR/DA queries the child asked long ago; the fresh emulator answered them again and the stray CPR bytes landed in the child's stdin as phantom input — one source of interactive claude's scrambled/misplaced UI after a TUI restart, tab park-wake, or second viewer attach. Replay parsing now mutes the emulator's auto-replies; live queries are still answered.
