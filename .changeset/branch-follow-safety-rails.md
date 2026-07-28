---
"@sma1lboy/kobe": patch
---

Harden the auto branch-follow that renames a placeholder task's branch from its first prompt: never rename a branch that has an upstream (or when the probe fails — ambiguity keeps the old name), and resolve a collision with an existing local branch to a `-2`/`-3`… suffixed unique name instead of silently keeping the placeholder.
