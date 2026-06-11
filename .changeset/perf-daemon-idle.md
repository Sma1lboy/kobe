---
"@sma1lboy/kobe": patch
---

The daemon now keeps its background work proportional to attached front-ends: `subscribe` honours its `channels` filter (a subscriber receives only the channels it asked for, replay and broadcast — omitting it still gets everything, fully back-compat), the git-status / auto-title collectors pause when no pane is subscribed and resume on the next subscribe, and a half-built client orchestrator is disposed when its connection fails instead of leaking a reconnect loop.
