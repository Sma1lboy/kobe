---
"@sma1lboy/kobe": patch
---

Don't install per-task engine hooks into a `main` project's real repo root. Moving the hook install to `ensureSession` (so existing tasks get hooks on enter) dropped the old `kind === "main"` guard, so entering a project (whose worktree IS the repo root) wrote kobe's hooks into the real repo's `.claude/settings.local.json` — which then fired for EVERY Claude Code session in that repo, including ones kobe never launched. The install is now gated on the worktree being a kobe-managed one (under `.claude/worktrees/`), so a project's repo root is never touched; real task worktrees are unaffected.
