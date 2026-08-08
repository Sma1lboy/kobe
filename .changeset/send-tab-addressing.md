---
"@sma1lboy/kobe": patch
---

`kobe api send` learns tab addressing: `--tab new` mints the next tab-N (consuming the same monotonic ordinal the TUI uses, so ids never collide) and spawns a fresh engine tab on an existing task; `--tab tab-N` delivers to that exact alive tab and fails typed (`TAB_NOT_FOUND`) instead of silently rerouting to the first engine. CLI-spawned tabs land in the persisted tab snapshot, so the sidebar tree renders and attaches them like TUI-opened tabs.
