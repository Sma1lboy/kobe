---
"@sma1lboy/kobe": patch
---

`kobe add <path>` now rejects a path that isn't a local git repository instead of saving it verbatim. Before this, `kobe add ,` (where `,` resolves to a non-existent directory) silently stored the garbage path as a saved project — which then surfaced as a synthetic main row in the PROJECTS sidebar that couldn't be deleted (`deleteTask` refuses main rows, so it failed with a confusing error). Add validates with `git rev-parse --is-inside-work-tree` and exits non-zero with a clear message; an already-saved garbage entry can still be cleared with `kobe remove`.
