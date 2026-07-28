---
"@sma1lboy/kobe": patch
---

Fix the returning "claude input box gone" on hidden tabs: the park sweep no longer parks a tab whose session is still streaming (an active stream overruns the 512KB host ring, degrading the lossless wake to a mid-stream replay), and the degraded wake's repaint wiggle now keeps a real gap between its shrink/restore resizes so an actively-streaming child can't race them into one coalesced same-size SIGWINCH that claude ignores.
