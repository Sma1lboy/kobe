---
"@sma1lboy/kobe": patch
---

`bun --filter kobe-web dev` now prints a startup banner showing whether it's wired to your PRODUCTION `~/.kobe` daemon or a sandbox home (with the resolved path and ports), so you can't mistake one for the other — and a new `dev:sandbox` script points `KOBE_HOME_DIR` at the same throwaway home the TUI's `dev:sandbox` uses (plus the `kobe-sandbox` tmux socket), so the bridge, the PTY engines, and tmux all run isolated and never touch production `tasks.json`. (Reminder: `bun run test` touches no daemon at all — that isolation was always unconditional.)
