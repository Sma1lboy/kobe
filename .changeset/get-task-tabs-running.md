---
"@sma1lboy/kobe": patch
---

`kobe api get-task` now returns the task's terminal tabs (`.tabs[]`: id/kind/title/vendor/liveVendor/lastTitle/autoTitle + per-tab `alive`), so an agent can discover `send --tab tab-N` targets from the product API instead of the `inspect` debug verb. `.running` (also in `collect` and `read-output`) is fixed to count ANY live hosted engine tab — previously only the canonical `tab-1` counted, so a task whose engine lived in a later tab reported `running:false`.
