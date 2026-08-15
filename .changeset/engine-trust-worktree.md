---
"@sma1lboy/rove": patch
---

fix: hosted engine sessions no longer die or stall on the vendor's first-run workspace-trust dialog (issue #28). Every vendor gates a never-seen directory — and every Rove task worktree is one: kimi's dialog default-cursor exits the process when the pasted first message's Enter lands on "Don't trust", while claude/codex sit at the prompt forever. Before spawning an engine into a Rove-created worktree, Rove now writes the vendor's own trust record via a new engine-owned `trustWorktree` registry hook (claude: `~/.claude.json` project entry, merge-preserving; codex: `config.toml` trusted-project table, append-only; kimi: `workspace-trust` record file), best-effort and never blocking a launch. Your own directories are untouched.
