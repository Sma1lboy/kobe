---
"@sma1lboy/kobe": patch
---

Add work items: browse a repo's GitHub issues from kobe and start a task on one. `kobe api workitem-list` reads issues through the `gh` CLI (filter by state, search, assignee, or label), and `kobe api workitem-start --number N` creates a task whose branch derives from the issue title and whose engine session opens with the issue title, body, and URL already in hand. The task keeps a link back to the issue.

Read-only by design: the issue stays in GitHub, nothing is copied into kobe's own issue store, and no state is written back. Requires `gh` installed and authenticated — failures say which of those is missing rather than reporting a generic error.
