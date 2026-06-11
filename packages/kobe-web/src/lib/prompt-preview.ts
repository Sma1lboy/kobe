/**
 * Last-prompt previews for the Overview cards — a one-line snapshot of what
 * each task was last asked to do, so the triage view answers "which task is
 * this again?" without opening it. Fetched through the bridge's /api/history
 * routes and cached by transcript mtime: a refresh costs one cheap sessions
 * call per task, and messages re-download only when the transcript actually
 * changed. Previews are a garnish — every failure path just leaves the card
 * without one, never an error state.
 */

import { useSyncExternalStore } from "react"
import { fetchMessages, fetchSessions, type HistoryMessage } from "./history.ts"

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

const defaultFetchers: PreviewFetchers = {
  sessions: fetchSessions,
  messages: fetchMessages,
}

interface PreviewEntry {
  mtime: number
  preview: string | null
}

const entries = new Map<string, PreviewEntry>()
const inflight = new Set<string>()
/** Last authoritative live-task set (armed by prunePromptPreviews) — lets a
 *  load that was in flight when its task got deleted skip the re-insert. */
let liveIds: ReadonlySet<string> | null = null
let snapshot: Record<string, string | null> = {}
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = Object.fromEntries(
    [...entries].map(([taskId, entry]) => [taskId, entry.preview]),
  )
  for (const listener of listeners) listener()
}

/**
 * Refresh one task's preview (fire-and-forget). mtime-gated: a repeat call
 * whose transcript hasn't changed stops after the cheap sessions call. An
 * in-flight task is never double-fetched.
 */
export async function loadPromptPreview(
  task: PreviewTask,
  fetchers: PreviewFetchers = defaultFetchers,
): Promise<void> {
  if (!task.worktreePath || inflight.has(task.id)) return
  inflight.add(task.id)
  try {
    const vendor = task.vendor ?? "claude"
    const { sessions, latestMtime } = await fetchers.sessions(
      task.worktreePath,
      vendor,
    )
    const cached = entries.get(task.id)
    // latestMtime 0 means "unknown", not a version: the codex reader's mtime
    // probe is scan-capped and can return 0 for a LIVE transcript, so a 0===0
    // hit would freeze the preview forever. Re-derive on every 0 (cheap when
    // sessions is empty — no messages download happens).
    if (cached && latestMtime !== 0 && cached.mtime === latestMtime) return
    const latest = sessions.at(-1)
    const preview = latest
      ? extractPromptPreview(await fetchers.messages(vendor, latest))
      : null
    // The task may have been deleted while this load was in flight — a dead
    // id must not be re-inserted after its prune.
    if (liveIds && !liveIds.has(task.id)) return
    entries.set(task.id, { mtime: latestMtime, preview })
    publish()
  } catch {
    // Garnish semantics: a failed fetch leaves the card preview-less.
  } finally {
    inflight.delete(task.id)
  }
}

export function getPromptPreviews(): Record<string, string | null> {
  return snapshot
}

/** taskId → one-line preview (null = transcript has no user prompt yet). */
export function usePromptPreviews(): Record<string, string | null> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPromptPreviews,
    getPromptPreviews,
  )
}

/**
 * Sweep entries for tasks that no longer exist — a task.snapshot is the
 * authoritative task list (mirrors store.ts pruneByTask, which does the same
 * for engineStates/jobs). Also arms the in-flight guard so a load racing a
 * delete can't re-insert the dead id.
 */
export function prunePromptPreviews(live: ReadonlySet<string>): void {
  liveIds = live
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
  liveIds = null
  snapshot = {}
}
