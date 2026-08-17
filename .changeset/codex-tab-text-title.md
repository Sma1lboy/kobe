---
"@sma1lboy/rove": patch
---

Show a real text title on Codex engine tabs instead of the session UUID or the worktree directory name. Codex titles an unnamed thread with its own thread id, a bare `codex` re-run in a tab's shell names itself after the project directory, and Codex tabs can't take a pinned session id at launch — so the first-prompt auto-title never applied. The naming pass now resolves an unpinned tab's session from the engine's own transcript store and re-derives the title when the engine reports a session switch in its OSC title stream (`terminalTitle.sessionIdFromTitle` — codex's unnamed thread title IS the thread UUID, so resuming another thread renames the tab to that thread's first prompt), while an engine-owned placeholder-title judgement (`terminalTitle.isPlaceholderTitle`, with the task worktree as context) lets those placeholder OSC titles fall through to the first-prompt summary — other engines can declare their own placeholder shapes.
