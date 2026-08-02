---
"@sma1lboy/kobe": patch
---

Continue a chat in a new tab (`ctrl+a` `c`), in the SAME worktree, with an engine picker deciding the shape. Same engine: a native fork — claude `--resume … --fork-session`, codex's `fork` subcommand — so both sides keep full context. Different engine: a handoff — the new session opens briefed with the previous engine's transcript path and reads it itself, which is how you carry a task across a usage limit (claude ⇄ codex, both directions). No transcript is ever converted between vendor formats. Distinct from `ctrl+a` `f`, which forks the worktree into a child task.
