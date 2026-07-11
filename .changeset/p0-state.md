---
"@sma1lboy/kobe": patch
---

Harden state.json writes: unique per-write tmp filenames (pid + nonce) prevent concurrent kobe processes from tearing each other's writes, and a malformed state.json is now backed up to `state.json.corrupt-<ts>` instead of being silently discarded.
