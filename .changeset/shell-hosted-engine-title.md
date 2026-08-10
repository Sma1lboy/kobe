---
"@sma1lboy/kobe": patch
---

Fix a shell tab running an engine reading as "shell N" after a restart. When you type `claude` inside a shell tab, kobe records the live engine on the tab; on the next start the sidebar has no attached PTY to probe and renders from that record. The naming rule resolved the vendor correctly but only carried it through for tabs already born as engine tabs, so a shell-hosted engine fell all the way to the bare shell default instead of being named after the engine running in it.
