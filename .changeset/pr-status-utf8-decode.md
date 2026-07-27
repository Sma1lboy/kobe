---
"@sma1lboy/kobe": patch
---

Fix garbled non-ASCII PR titles in the sidebar check-state chip: the daemon's PR-status poller decoded each `gh pr list --json` stdout chunk on its own, so a multi-byte UTF-8 character in a PR title (Chinese, emoji, accented text) that straddled a ~64 KB pipe-chunk boundary turned into replacement glyphs (`�`) before the JSON was parsed and the title persisted to the task — the same defect already fixed for the background git helpers now closed on the `gh` capture path by joining the raw bytes before decoding.
