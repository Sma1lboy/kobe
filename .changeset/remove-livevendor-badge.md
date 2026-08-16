---
"@sma1lboy/rove": patch
---

Remove the sidebar ⚡ engine badge introduced with the live shell-tab identity: the row label already tracks the live OSC title, so the badge was a second parallel channel for the same information — and it lit redundantly on engine tabs running their own vendor. The data layer stays: `liveVendor` still feeds get-task/tab-snapshot from the live foreground walk, and a shell tab with a confirmed engine still renders through the same row path as an engine tab.
