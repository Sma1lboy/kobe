---
"@sma1lboy/kobe": patch
---

ChatTab: a manual `F2` rename of the origin tab now survives a tmux server restart. The name is captured into `tasks.json` (`Task.chatTabName`) and restored when the window is rebuilt fresh — previously it was held only in tmux memory, so `kobe reset` / a reboot dropped it and the auto-namer re-derived the first-prompt title over your name. The daemon's chat-tab namer tells your `F2` rename apart from its own auto name via a new `@kobe_auto_name` window option, so it never re-captures the auto name as a manual override. Only the origin tab is persisted (extra Ctrl+T tabs aren't rebuilt across a server restart, so they keep the pure auto-name behaviour).
