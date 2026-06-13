/**
 * Last-prompt previews for the Overview cards — a one-line snapshot of what
 * each task was last asked to do, so the triage view answers "which task is
 * this again?" without opening it. Fetched through the bridge's /api/history
 * routes and cached by transcript mtime: a refresh costs one cheap sessions
 * call per task, and messages re-download only when the transcript actually
 * changed. Previews are a garnish — every failure path just leaves the card
 * without one, never an error state.
 */

import type {
  fetchMessages,
  fetchSessions,
  HistoryMessage,
} from "./history.ts"

/** Card preview cap — one dense line; the full prompt lives in the transcript. */
export const PREVIEW_MAX_CHARS = 120

/** Collapse prompt text to a single trimmed line, capped with an ellipsis. */
export function collapsePreviewLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > PREVIEW_MAX_CHARS
    ? `${line.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
    : line
}

/**
 * The last thing the user actually TYPED: scan backwards for the newest
 * user-role message with non-blank prose. Codex emits tool results on
 * role:"user" records, so a user message with no text block is transcript
 * plumbing, not a prompt — skipped, falling back to the previous real prompt.
 */
export function extractPromptPreview(
  messages: readonly HistoryMessage[],
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const prose = message.blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ")
    const line = collapsePreviewLine(prose)
    if (line) return line
  }
  return null
}

/** The task fields a preview fetch needs (subset of types.ts Task). */
export interface PreviewTask {
  id: string
  worktreePath: string
  vendor?: string
}

/** Injectable for tests — production callers use the real /api/history pair. */
export interface PreviewFetchers {
  sessions: typeof fetchSessions
  messages: typeof fetchMessages
}

interface PreviewEntry {
  mtime: number
  preview: string | null
}

const entries = new Map<string, PreviewEntry>()
const inflight = new Set<string>()
let snapshot: Record<string, string | null> = {}
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = Object.fromEntries(
    [...entries].map(([taskId, entry]) => [taskId, entry.preview]),
  )
  for (const listener of listeners) listener()
}

export function getPromptPreviews(): Record<string, string | null> {
  return snapshot
}

/**
 * Sweep entries for tasks that no longer exist — a task.snapshot is the
 * authoritative task list (mirrors store.ts pruneByTask, which does the same
 * for engineStates/jobs).
 */
export function prunePromptPreviews(live: ReadonlySet<string>): void {
  let dropped = false
  for (const taskId of entries.keys()) {
    if (!live.has(taskId)) {
      entries.delete(taskId)
      dropped = true
    }
  }
  if (dropped) publish()
}

/** Test-only: drop all cached previews and in-flight tracking. */
export function resetPromptPreviews(): void {
  entries.clear()
  inflight.clear()
  snapshot = {}
}
