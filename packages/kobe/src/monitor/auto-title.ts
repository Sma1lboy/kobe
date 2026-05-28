/**
 * Derive a task title from its session transcript (KOB-233).
 *
 * In the v0.6 tmux model kobe never sees the user's prompt directly —
 * `claude` runs interactively in a tmux pane — so a task created via
 * the dialog keeps its placeholder title (`(new task)`) until we read
 * it back from the session JSONL. We take the FIRST user message of the
 * task's earliest session and truncate it via `deriveTitleFromPrompt`
 * (no model call — pure string work, the cheap replacement for the old
 * headless `claude -p` naming path).
 *
 * Claude-specific for now: it reads the claude-code-local history, the
 * same way `monitor/cost.ts` already does. Codex auto-naming is a
 * follow-up — route through the engine contract when that lands.
 */

import { listSessionFilesForWorktree, readHistory } from "@/engine/claude-code-local/history"
import { deriveTitleFromPrompt } from "@/orchestrator/title"

/**
 * The truncated first-user-prompt title for the task rooted at
 * `worktree`, or `""` when there's no session / no user message yet
 * (caller leaves the placeholder in place). Never throws on a missing
 * file — returns `""`.
 */
const MAX_SESSIONS_SCANNED = 8

export async function deriveTitleFromSession(worktree: string): Promise<string> {
  if (!worktree) return ""
  const sessions = await listSessionFilesForWorktree(worktree)
  if (sessions.length === 0) return ""
  // Walk sessions oldest-first (the task's origin conversation comes
  // first) and return the first that yields a usable title. We don't
  // stop at the very earliest session: its opening "user" record can be
  // a non-text block (a tool result, a slash-command echo), which would
  // give an empty title. Capped so a busy worktree doesn't read dozens
  // of transcripts.
  const oldestFirst = [...sessions].sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, MAX_SESSIONS_SCANNED)
  for (const session of oldestFirst) {
    const messages = await readHistory(session.sessionId)
    const firstUser = messages.find((m) => m.role === "user")
    if (!firstUser) continue
    const text = firstUser.blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join(" ")
    const title = deriveTitleFromPrompt(text)
    if (title) return title
  }
  return ""
}
