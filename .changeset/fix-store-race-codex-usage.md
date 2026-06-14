---
"@sma1lboy/kobe": patch
---

More audit fixes:

- **Issue store lost writes across repos.** The daemon issue store keeps every repo in one file but serialized writes per-repo, so two repos mutating concurrently could each read the file before the other's write landed and clobber it. Store access is now serialized on the file.
- **Codex usage went stale.** When Codex `turn.completed` records carried no timestamp, only the first turn's token usage was kept and every later turn was discarded, so the session reported stale numbers. It now follows file order to the latest turn.
- **Codex session lookup.** A rollout file is now matched by its full session UUID instead of a loose filename suffix, and an empty session id resolves to nothing instead of an arbitrary recent session.
- **`kobe daemon stop` with no daemon running** now reports cleanly and exits 0 instead of crashing with a "failed to start" error.
