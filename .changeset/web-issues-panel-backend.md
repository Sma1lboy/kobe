---
"@sma1lboy/kobe": patch
---

Add the backend for the web Issues panel: a daemon-owned issue tracker (create / edit / set-status / link / unlink / delete), keyed per repo by git common-dir and persisted at `~/.kobe/issues.json`. The daemon exposes it over `issue.list` / `issue.mutate` and republishes a repo's issue snapshot on every change; finishing a task whose issue is linked mirrors that issue to done automatically. Conflict radar is unchanged and keeps publishing alongside the new issue channel.
