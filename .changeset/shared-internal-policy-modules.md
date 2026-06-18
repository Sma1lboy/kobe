---
"@sma1lboy/kobe": patch
---

Internal: shared several duplicated implementation policies behind deeper modules. Shell command quoting now lives in one tested helper, long-lived pane row identity reconciliation is shared by FileTree and Sidebar, and the web bridge plus PTY sidecar use one Origin policy module for loopback/LAN-host checks.
