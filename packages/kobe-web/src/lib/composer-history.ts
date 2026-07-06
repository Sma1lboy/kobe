const KEY_PREFIX = "kobe-web.composer-history."
const CAP = 50

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

export function pushHistory(taskId: string, text: string): string[] {
  const trimmed = text.trim()
  const prev = loadHistory(taskId)
  if (!trimmed) return prev
  const next = prev[0] === trimmed ? prev : [trimmed, ...prev].slice(0, CAP)
  try {
    localStorage.setItem(KEY_PREFIX + taskId, JSON.stringify(next))
  } catch {}
  return next
}

export function navigateHistory(
  history: readonly string[],
  cursor: number,
  dir: "up" | "down",
  liveDraft: string,
): { cursor: number; value: string } | null {
  if (dir === "up") {
    if (history.length === 0) return null
    const next = Math.min(cursor + 1, history.length - 1)
    if (next === cursor) return null
    return { cursor: next, value: history[next] }
  }
  if (cursor < 0) return null
  const next = cursor - 1
  return next < 0
    ? { cursor: -1, value: liveDraft }
    : { cursor: next, value: history[next] }
}
