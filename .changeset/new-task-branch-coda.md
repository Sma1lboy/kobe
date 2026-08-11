---
"@sma1lboy/kobe": patch
---

New worktree tasks' first prompt now carries a branch-rename coda (issue #8): every entry point that creates a task and delivers its first prompt (`add --prompt`, `fan-out`, quick-fork, issue-chat, automation/work-item starts) appends one instruction asking the agent to `kobe api set-branch` the auto-generated placeholder branch to a descriptive name. Applied once at the shared launch convergence point (`firstMessageFor` via a new `new-task` prompt intent), so prompts into existing sessions (`send`, `send --tab new`, `dispatch`, cross-engine handoffs) are never modified.
