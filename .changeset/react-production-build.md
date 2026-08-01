---
"@sma1lboy/kobe": patch
---

Fix unbounded memory growth in the TUI client. The published bundle shipped React's *development* build: `Bun.build` defaults `process.env.NODE_ENV` to `"development"`, so the bundler resolved react and react-reconciler to their development entries and inlined them. Those builds keep per-update debug bookkeeping alive, which grows without bound in a long-lived TUI — a session climbed several GB over a few hours, and the pressure could make tasks disappear from the sidebar.

Both `build.ts` and `compile.ts` now pin `NODE_ENV=production`, and an architecture test guards the pin. The npm bundle also drops ~100 KB.
