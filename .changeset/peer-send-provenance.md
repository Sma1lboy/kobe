---
"@sma1lboy/kobe": patch
---

`kobe api send` issued from inside another kobe task now prefixes the prompt with `[KOBE PEER]` provenance — sender title, task id, and the exact reply command — so agents can message each other directly without a coordinator or human relay. `--plain` skips the prefix. The kobe agent skill (v8) teaches the peer-messaging convention.
