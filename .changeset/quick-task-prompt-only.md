---
"@sma1lboy/kobe": patch
---

**`prefix F` quick-create is now prompt-only.** Instead of opening the full new-task dialog (repo + base branch + engine pickers), the quick-create chord opens a dedicated page that asks for just a prompt and fills everything else from the task you fired it in: the same source repo, your last-selected engine (clamped to a detected one), the repo's current branch as the base, and the engine's own default model. On submit it creates the task and delivers your prompt as its first message, then closes. If no repo can be resolved (a rare first-run case) it falls back to the full new-task dialog so creation is never a dead end.
