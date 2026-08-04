---
"@sma1lboy/kobe": patch
---

kobe as a windowed terminal app (experiment): the kobe-desktop Electron shell returns and opens /chat — left rail mirrors the TUI tree sidebar (INBOX header, Active/Archives, Kanban/Routines nav, project → worktree → session rows with the TUI state-glyph vocabulary), the center is the task's REAL engine terminal (the same PTY the workspace vendor tab attaches), with a "Chat" view that re-renders the same session as GUI conversation rows; right is a session-info panel. A permission prompt auto-snaps the center back to the terminal. Fix: embedded-terminal children no longer inherit ancestor Claude-session markers (CLAUDE_CODE_CHILD_SESSION et al.), which silently disabled engine transcript persistence when kobe was launched from inside a Claude session.
