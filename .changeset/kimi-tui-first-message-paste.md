---
"@sma1lboy/rove": patch
---

Kimi sessions started from the TUI and the web dashboard now receive their first message (issue #25 follow-up).

`rove api send/add --prompt` already pasted kimi's first message post-spawn (kimi's positional argv slot is a subcommand, so an argv prompt exits the engine `Unknown command`), but the TUI's own spawn path still pinned argv — a quick-fork, issue-chat, or cross-engine-handoff prompt on a kimi tab still killed the session — and the web engine-spec path silently dropped a repo's init-prompt. The tab spawn now surfaces the message as `firstMessage` instead of appending it to the launch line, the hosted PTY bracketed-pastes it once the engine process is up (fresh spawns only — a reattach never redelivers), and the web PTY sidecar does the same for spec-carried messages.
