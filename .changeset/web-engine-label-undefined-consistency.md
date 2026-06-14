---
"@sma1lboy/kobe": patch
---

Fix the engine chip showing two different labels for the same engine in a mixed-engine workspace: an unset task vendor now resolves to the registry's "claude" label (and any user display-name override) exactly like an explicit `vendor: "claude"`, instead of a hard-coded lowercase fallback — so two tasks on the same engine never render mismatched chips or tooltips.
