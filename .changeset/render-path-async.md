---
"@sma1lboy/kobe": patch
---

More "never block the UI" hardening: the sidebar's project-branch labels and the Ops pane's Create-PR prompt no longer run synchronous git on the render thread (both now go through an async background poller / async spawn with timeouts), and a CI guard test bans new synchronous subprocess calls from render paths.
