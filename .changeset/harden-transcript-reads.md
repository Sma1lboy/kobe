---
"@sma1lboy/kobe": patch
---

Harden engine transcript/credential file reads against OOM/hang. The Claude/Codex/Copilot history readers and `account-detect` now stat-bound a file before slurping it (oversize → an empty/"not detected" result instead of loading a multi-GB file into a string) and cap each JSONL line's length before `JSON.parse`, skipping a pathological mega-line exactly like a malformed one. The Codex rollout date-tree traversal also caps how many paths it collects, consistent with the existing `MAX_*` scan caps, and notes once when truncated so a corrupt `~/.codex/sessions` can't grow an unbounded array. Every bound degrades, never throws into auto-title/Ops/history, and never logs file contents.
