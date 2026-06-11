/**
 * Per-task prompt history for the engine composer — a shell-like recall ring so
 * ↑/↓ walk your previously-sent prompts. Persisted in localStorage per task so
 * it survives reloads. `navigateHistory` is pure (the cursor math); load/push
 * touch localStorage.
 */

const KEY_PREFIX = "kobe-web.composer-history."
const CAP = 50

/** Recent prompts for a task, NEWEST first. */
export function loadHistory(taskId: string): string[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + taskId)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr)
      ? arr.filter((x): x is string => typeof x === "string")
      : []
  } catch {
    return []
  }
}

/** Record a sent prompt (newest-first, immediate-duplicate-collapsed, capped),
 *  returning the new list. A blank prompt is ignored. */
export function pushHistory(taskId: string, text: string): string[] {
  const trimmed = text.trim()
  const prev = loadHistory(taskId)
  if (!trimmed) return prev
  const next = prev[0] === trimmed ? prev : [trimmed, ...prev].slice(0, CAP)
  try {
    localStorage.setItem(KEY_PREFIX + taskId, JSON.stringify(next))
  } catch {
    // best-effort; recall just won't persist
  }
  return next
}

/**
 * Walk the recall ring. `cursor` is -1 while editing the live draft, else an
 * index into `history` (0 = newest). `up` goes to older prompts, `down` back
 * toward the live draft (restoring `liveDraft` when it returns to -1). Returns
 * null when there's nowhere to go (so the caller lets the arrow do its default
 * text-caret movement).
 */
export function navigateHistory(
  history: readonly string[],
  cursor: number,
  dir: "up" | "down",
  liveDraft: string,
): { cursor: number; value: string } | null {
  if (dir === "up") {
    if (history.length === 0) return null
    const next = Math.min(cursor + 1, history.length - 1)
    if (next === cursor) return null // already at the oldest
    return { cursor: next, value: history[next] }
  }
  // down
  if (cursor < 0) return null // already on the live draft
  const next = cursor - 1
  return next < 0
    ? { cursor: -1, value: liveDraft }
    : { cursor: next, value: history[next] }
}
