---
"@sma1lboy/rove": patch
---

fix: `send --tab new --vendor kimi --prompt …` (and `add --prompt` / automation starts) no longer kill the kimi engine with its own `Unknown command` error. Kimi's positional CLI slot is a subcommand, not an initial prompt, so the first message now rides outside the launch argv for paste-delivery vendors and is bracketed-pasted once the engine process is actually up (new `firstMessageDelivery` registry contract; claude/codex/custom engines keep the argv path). The TUI's own spawn path pins argv delivery explicitly until it grows a post-spawn paste hook.
