---
"@sma1lboy/kobe": patch
---

Beta (web): preview an archived task's read-only engine history. When a task is archived (e.g. after its git worktree is removed), its transcript still lives in the engine's vendor store keyed by the worktree path, so the existing `ChatTranscript` viewer can render it with no live engine. Behind a default-off experimental gate — Settings → Experimental → "Archived history preview" — which makes archived rows in the rail clickable, opening the transcript in a read-only drawer. Claude + Codex (and Copilot) are covered via the neutral `EngineHistoryReader`; no vendor formats are touched in the UI.
