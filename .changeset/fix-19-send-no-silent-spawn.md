---
"@sma1lboy/kobe": patch
---

`send` no longer silently spawns a duplicate engine when the canonical tab cannot be resolved (issue #19). `findHostedEngineKey` now matches the engine binary as a word in the full shell-wrapped launch argv (the old `command[0]` fallback was dead code — hosted sessions always launch via `<shell> -ilc`), so a surviving engine tab receives the prompt even when `tab-1` is gone. When live tabs exist but none resolves as an engine, delivery fails loud with a typed `NO_ENGINE_TAB` error (hint + `nextCommandArgs`) instead of booting an unsandboxed engine and reporting ok to both sides. Auto-start remains only for a task with no live session at all, cwd'd at the task's worktree, with `started: true` marking the fresh session.
