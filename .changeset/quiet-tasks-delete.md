---
"@sma1lboy/kobe": patch
---

Move task worktree cleanup into a durable daemon background job so deleting a large task returns control immediately, survives daemon restarts, and keeps failures visible and retryable in the sidebar.
