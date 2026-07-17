---
"@sma1lboy/kobe": patch
---

Codex activity detection now tracks the rollout the agent is actually writing to. A worktree's "new activity" badge and turn-completion detection pick the Codex rollout with the newest modified time (matching how the Claude and Copilot readers already work) instead of whichever rollout was created most recently — so a resumed older session that a newer, idle rollout was created after no longer reports stale activity, and the turn detector reads the right transcript for its completion marker.
