---
"@sma1lboy/kobe": patch
---

**Web dashboard: Issues panel** — `kobe web` gets an `/issues` page that surfaces each repo's committed `docs/issues.json`. Switch projects with chips (or stay on the all-projects overview with per-repo status counts), browse a four-column board (`open` / `doing` / `hold` / `done` — `hold` is a new parking status the archive sweep ignores), search, create and edit issues in a detail drawer with markdown rendering, and one-click **quick start** an issue: kobe creates a task in that repo, flips the issue to `doing`, and pastes the issue as the engine's first prompt via the existing PTY delivery path. Reach it from the top bar (`CircleDot`) or the command palette. The bridge serves `GET/POST /api/issues` with per-repo write serialization, git-repo validation, and normalization of hand-edited entries.
