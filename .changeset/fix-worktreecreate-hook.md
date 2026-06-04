---
"@sma1lboy/kobe": patch
---

Stop installing a global `WorktreeCreate` hook — it broke `claude --worktree` / `EnterWorktree` in every repo. `WorktreeCreate` is a VCS *provider* hook: its mere presence makes Claude Code delegate worktree creation to the hook and skip the native git path, and kobe's hook only observed (returned no path), so Claude failed with "WorktreeCreate hook failed: hook succeeded but returned no worktree path." kobe now removes that hook on launch (merge-safe; your own WorktreeCreate hooks are preserved) and `kobe hook setup` is a deprecated cleanup-only no-op. External-worktree sync is reborn correctly on the daemon: a session that starts (SessionStart) in an unadopted worktree under a repo kobe already tracks is auto-adopted as a task — no hook, no footgun. Manual adoption (New Task dialog / `kobe adopt`) is unchanged.
