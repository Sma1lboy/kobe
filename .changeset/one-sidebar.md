---
"@sma1lboy/kobe": patch
---

There is one sidebar now. The flat task list the tree replaced on 2026-08-01 was kept as a one-key way back, but nine days in nobody had gone back and every sidebar change had to be written twice — with nothing failing when it wasn't. That cost three bugs: the tree's move mode shipped dead, the brand header went missing from one mount, and the Active/Archived row kept showing on a fresh install because the gate landed on the flat copy only. Removing it drops ~1100 lines along with the Settings toggle, the `sidebar.mode` preference, and the hover tooltips the tree never had.
