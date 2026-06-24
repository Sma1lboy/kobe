---
"@sma1lboy/kobe": patch
---

The Tasks sidebar now shows live PR check status (KOB-10). A daemon poller runs `gh pr view` for each task's branch (GitHub only) and writes the result onto the task, so the sidebar row gains a right-stuck chip — ✓ passing / ✗ failing / • pending — that updates as CI moves, without leaving the TUI. Status is persisted on the task (it rides the existing snapshot push, so every Tasks pane and the web board see it, and it survives a daemon restart) and only ever written from a successful `gh` call, so a missing/unauthed `gh` or a transient network blip never clears a known chip. The poller backs off for branches with no PR and for merged/closed PRs, and pauses entirely when no pane is attached.
