---
"@sma1lboy/kobe": patch
---

Apply write backpressure on the daemon's per-client socket fan-out. Each subscribed client now writes through a bounded `ClientWriter` that pauses when `socket.write()` reports a full send buffer and resumes on `'drain'`, so a slow/stalled client no longer makes Node queue unbounded heap on the long-lived daemon (a prior OOM risk under a fast event stream). The queue sheds the oldest droppable channel frames past a high-water mark while never dropping `daemon.stopping` lifecycle or RPC response frames, never reordering a client's stream, and never letting one slow client stall the fan-out for healthy ones.
