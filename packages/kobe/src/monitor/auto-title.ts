/**
 * Derive a task title from its session transcript (KOB-233).
 *
 * In the v0.6 tmux model kobe never sees the user's prompt directly —
 * the engine runs interactively in a tmux pane — so a task created via
 * the dialog keeps its placeholder title (`(new task)`) until we read
 * it back from the session transcript. We take the FIRST user message
 * of the task's origin session and truncate it via
 * `deriveTitleFromPrompt` (no model call — pure string work, the cheap
 * replacement for the old headless `claude -p` naming path).
 *
 * Engine-aware: the task's `vendor` selects which on-disk transcript
 * store to read — claude-code's per-worktree `~/.claude/projects/*`
 * vs Codex's global `~/.codex/sessions/**` rollouts (filtered by the
 * recorded cwd). Both expose a `readHistory(sessionId)` returning the
 * neutral `Message[]`, so the extraction below stays vendor-neutral.
 */

import * as claudeHistory from "@/engine/claude-code-local/history"
import * as codexHistory from "@/engine/codex-local/history"
import * as copilotHistory from "@/engine/copilot-local/history"
import { deriveTitleFromPrompt } from "@/orchestrator/title"
import type { Message } from "@/types/engine"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

const MAX_SESSIONS_SCANNED = 8

/** Origin session ids (oldest-first) + the vendor's history reader. */
async function originSessions(
  worktree: string,
  vendor: VendorId,
): Promise<{ ids: readonly string[]; read: (sessionId: string) => Promise<Message[]> }> {
  if (vendor === "codex") {
    return { ids: await codexHistory.listSessionIdsForWorktree(worktree), read: codexHistory.readHistory }
  }
  if (vendor === "copilot") {
    return { ids: await copilotHistory.listSessionIdsForWorktree(worktree), read: copilotHistory.readHistory }
  }
  const files = await claudeHistory.listSessionFilesForWorktree(worktree)
  const ids = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).map((f) => f.sessionId)
  return { ids, read: claudeHistory.readHistory }
}

/**
 * The truncated first-user-prompt title for the task rooted at
 * `worktree`, or `""` when there's no session / no user message yet
 * (caller leaves the placeholder in place). Never throws on a missing
 * file — returns `""`.
 */
export async function deriveTitleFromSession(
  worktree: string,
  vendor: VendorId = DEFAULT_TASK_VENDOR,
): Promise<string> {
  if (!worktree) return ""
  const { ids, read } = await originSessions(worktree, vendor)
  // Walk sessions oldest-first (the task's origin conversation comes
  // first) and return the first that yields a usable title. We don't
  // stop at the very earliest session: its opening "user" record can be
  // a non-text block (a tool result, a slash-command echo), which would
  // give an empty title. Capped so a busy worktree doesn't read dozens
  // of transcripts.
  for (const sessionId of ids.slice(0, MAX_SESSIONS_SCANNED)) {
    const messages = await read(sessionId)
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
