---
"@sma1lboy/kobe": patch
---

Fix the Ops pane growing to multiple GB of memory over long sessions. Every fs-watch refresh rebuilt the file tree with all-new row objects, destroying and recreating every row's renderables — and @opentui/core 0.2.4 retains a small amount of native memory per renderable create/destroy cycle, so a busy worktree (thousands of refreshes a day) leaked without bound. Refreshes whose git output is unchanged now suppress entirely, and changed refreshes reconcile by row identity so only rows that actually changed re-render.
