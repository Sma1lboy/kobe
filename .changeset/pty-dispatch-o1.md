---
"@sma1lboy/kobe": patch
---

Inbound pty-frame routing is now O(1) per chunk instead of O(open-tabs).

Every open terminal tab used to register its own `pty.data`/`pty.exit` handler on the one shared pty-host client, so the client walked N handlers (N-1 pure key-mismatch rejections) for every chunk an interactive engine streamed — on the busiest inbound path. A single keyed dispatcher now installs once per client and does one `Map` lookup per frame; each hosted handle registers/deregisters through its existing teardown so detach/kill/park never leave a stale route. Behavior is identical: a frame still reaches exactly its own tab and unknown keys drop.
