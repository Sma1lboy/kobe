---
"@sma1lboy/rove": patch
---

Make the runtime's default spellings canonical Rove. Bare shell tabs now export `ROVE_TASK_ID`/`ROVE_TAB_ID` alongside the `KOBE_*` aliases, matching engine tabs — a shell never passes through the CLI's `ROVE_* → KOBE_*` mirror, so an engine typed into one previously saw only the legacy names. `rove api` help and errors advertise `$ROVE_TASK_ID`, the foreign-daemon-socket error tells you to run `rove daemon stop`, per-repo PR instructions resolve `.rove/pr-instructions.md` first with `.kobe/` as a fallback, and `bun run dev` plus the root `daemon*` scripts drive the `rove` entry point. Every legacy spelling stays accepted, with explicit `dev:kobe` / `daemon:kobe` scripts keeping the `kobe` entry exercised.
