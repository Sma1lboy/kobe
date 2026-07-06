---
"@sma1lboy/kobe": patch
---

Embedded terminal hardening (issue #16, revival checklist #4/#5): a dead engine/shell now surfaces — every PTY backend gains an onExit notification (fires immediately for fast crashes) and the pane shows an "process exited — F5 restarts it" banner over the frozen snapshot instead of silently freezing. The registry, key-byte translation, and the newly extracted pure viewport math are pinned by unit tests.
