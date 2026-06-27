---
"@sma1lboy/kobe": patch
---

refactor: back the daemon file-watch trigger with chokidar

Replace the hand-rolled `node:fs.watch` + manual polling safety-net in the
shared file-watch trigger with chokidar, which handles the cross-platform
fs-event edge cases (macOS rename/inode churn, rapid bursts, atomic saves)
the bespoke poll was compensating for. The exported signature, basename
filtering, debounce, and `stop()` teardown are unchanged, so the ui-prefs and
keybindings watchers are untouched.
