---
"@sma1lboy/kobe": patch
---

Terminal splits now cap tmux-style nesting at 4 levels (`MAX_SPLIT_DEPTH`) — a split that would nest deeper is a silent no-op. Same-orientation splits insert siblings and stay unlimited.
