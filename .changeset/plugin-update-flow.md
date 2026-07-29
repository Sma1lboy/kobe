---
"@sma1lboy/kobe": patch
---

Plugin update flow: `kobe plugin outdated` probes GitHub-installed plugins against upstream (one `ls-remote` each), `kobe plugin update <id…>|--all` reinstalls stale ones (config/state survive — only the managed checkout is replaced), and Settings → Plugins shows an "update available" mark from the CLI-written cache, so the TUI never touches the network.
