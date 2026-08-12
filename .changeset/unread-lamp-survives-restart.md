---
"@sma1lboy/kobe": patch
---

Sidebar completions you have already read stay read after a restart. The unread lamp's seen bit lived only in the running TUI, while the daemon keeps reporting the same finished turn — so relaunching kobe re-lit every session you had already looked at. The seen mark is now persisted per (task, tab) with the completion's own timestamp, so a new turn still arrives unread.
