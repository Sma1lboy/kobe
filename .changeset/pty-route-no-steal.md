---
"@sma1lboy/kobe": patch
---

fix: a second viewer of a terminal session no longer freezes the first

The 0.7.86 O(1) pty-frame dispatcher kept ONE handle per session key, so a second attach to the same session (a duplicate pane host, the same tab viewed twice) silently stole the byte stream — the first pane froze on its last frame while the engine kept running. Routing is now a set per key (every live handle gets every frame), and detaching one viewer no longer tears down the shared host sink a surviving sibling still needs.
