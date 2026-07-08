---
"@sma1lboy/kobe": patch
---

Internal: split `cli/api-cmd.ts` (was ~1362 lines, over the file-size cap) into `cli/api/{types,flags,schema,runtime,handler-helpers,handlers-tasks,handlers-fanout,verbs}.ts`, with `api-cmd.ts` kept as the dispatcher + stable re-export barrel. Pure mechanical refactor — `kobe api schema --all` output is byte-identical before/after, and all existing tests keep importing from `./api-cmd.ts` unchanged.
