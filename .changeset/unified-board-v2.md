---
"@sma1lboy/kobe": patch
---

Unified board v2: Workspace and Board are now peer views with a top-left toggle (no back-link). Issues decouple from tasks — a task no longer reverse-references an issue (`Task.issueId` dropped); the issue→task link is one-way via `Issue.taskId`, the board dedups an issue whose linked task is live, and task→done mirrors to its issue by reverse lookup. The board is the ticket-intake surface: a slide-in panel creates issues with title/description and pasted/dropped image uploads (disk asset store under `<KOBE_HOME>/.kobe/issue-assets/`, served by the bridge, safely rendered), then Save or Execute-immediately. Clicking an issue opens a detail drawer to edit it and pick engine + reasoning effort before Start; issue cards carry a one-click quick-start and drop the inline status buttons. Task cards drop the redundant hover column-jump tags (drag still moves them).
