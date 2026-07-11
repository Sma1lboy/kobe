---
"@sma1lboy/kobe": patch
---

Harden the daemon client/transport: the web transport now degrades to socket-only on a port conflict instead of crashing the daemon or SIGTERM-ing the port holder (with the real reason surfaced via `daemon status`); daemon RPCs gained a per-request deadline so a wedged daemon converges on the visible disconnect→reconnect path instead of silently freezing the UI; and event dispatch isolates a throwing subscriber so one bad handler can't make a pane go deaf.
