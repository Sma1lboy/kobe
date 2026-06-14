---
"@sma1lboy/kobe": patch
---

Internal: a workspace tab's kind drove two cross-cutting facts by string-matching scattered across the code — whether it owns a server-side PTY (the `kind === "vendor" || kind === "terminal"` guard appeared three times: reset-layout, prune-missing-tasks, and tab close) and how a fresh tab is titled (`Vendor N` / `Terminal N` / `Chat` / `New tab` built in five different helpers). Both now come from one `lib/tab-kinds` registry (`tabHasPty` + `nextTabTitle`), unit-tested in isolation, so a new tab kind declares its PTY-ness and title rule in one place instead of being threaded through every guard. The per-kind render stays a type-narrowed switch (the discriminated union keeps it type-safe). No behavior change.
