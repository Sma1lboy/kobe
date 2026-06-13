---
"@sma1lboy/kobe": patch
---

**Web dashboard: unified Board** — Issues and tasks now live on one project-grouped kanban instead of separate pages. The board's Backlog column is the project's open issues; `in_progress` / `in_review` / `done` are its tasks. An issue and the task it spawned are associated by id (`Issue.taskId` / `Task.issueId`), so a started issue is deduped out of Backlog and its card carries a `#<issueId>` back-link to the originating issue; deleting the task resurfaces the issue back into Backlog. Clicking a Backlog card opens an editable drawer where you pick an engine and Start, which creates the task in that project, links it, and pastes the issue as the engine's first prompt. Task `done` mirrors back to the linked issue. Top-bar navigation is now just Workspace and Board.

This also removes the dead conflict-radar feature end-to-end — the now-unused `task.conflicts` collector, channel, protocol/store/types members, and SSE wiring — along with the orphaned prompt-preview module. The `docs/design/conflict-radar.md` design report is deleted and its remaining references (dispatcher.md) cleaned up.
