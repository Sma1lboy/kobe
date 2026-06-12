---
"@sma1lboy/kobe": patch
---

**Conflict dispatcher (experimental)** — flip Settings → Dev → "Conflict dispatcher" and each repo's main session becomes an autonomous coordinator: new claude launches there get a dispatcher system prompt, the daemon feeds it conflict-radar digests over a new `session.deliver` channel, and it can message the conflicting tasks' live sessions with the new `kobe api dispatch --task-id <id> --prompt <text>` (daemon-routed — the front-end hosting the session does the paste, so web-PTY sessions never grow a duplicate tmux twin). On the web board, a `dispatcher` chip appears when the board is scoped to a single project and opens that repo's main session. Off by default; see `docs/design/dispatcher.md`.
