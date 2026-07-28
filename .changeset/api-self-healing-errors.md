---
"@sma1lboy/kobe": patch
---

`kobe api` rejections are now self-healing for agent callers: high-traffic errors (unknown verb, unknown/invalid task id, daemon unreachable, malformed flags on the fan-out path, bad `--vendor`/enum values) carry a machine-actionable `hint` plus `nextCommandArgs` — argv for the same `kobe` executable the caller can run verbatim to recover (e.g. `["api","list"]` after the new typed `TASK_NOT_FOUND`). The envelope stays `{"error":{"message","code",...}}`, so existing consumers are unaffected.
