---
"@sma1lboy/kobe": patch
---

Internal: cover the Chat transcript usage math — `summarizeUsage` (session in/out token totals + the live context estimate, which is the last turn's full prompt = input + cache read + cache creation) and `formatTokens` (k/m suffixes). 91 web tests.
