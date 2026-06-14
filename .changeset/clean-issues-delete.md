---
"@sma1lboy/kobe": patch
---

Delete issues from the board: a Trash affordance on issue cards removes the
daemon-owned issue record (gated behind a confirm dialog), backed by a new
`delete` op in the issues store + a `deleteIssue` web client helper.
