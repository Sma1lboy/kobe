import { watch } from "node:fs"
import type { FileStatus } from "./git"
import type { Row } from "./rows"

export function statusToken(s: FileStatus): "warning" | "success" | "error" | "textMuted" | "info" {
  switch (s) {
    case "M":
      return "warning"
    case "A":
      return "success"
    case "D":
      return "error"
    case "?":
      return "textMuted"
    case "R":
    case "C":
    case "U":
    case "T":
      return "info"
  }
}

export function summarizeGitError(raw: string, t: (key: string) => string): string {
  const m = raw.toLowerCase()
  if (m.includes("not a git repository")) return t("files.error.notGitRepo")
  if (m.includes("does not exist") || m.includes("enoent")) return t("files.error.pathMissing")
  if (m.includes("permission denied") || m.includes("eacces")) return t("files.error.permissionDenied")
  if (m.includes("git: not found") || m.includes("command not found")) return t("files.error.gitNotInstalled")
  const colon = raw.indexOf(": ")
  if (colon >= 0 && raw.startsWith("git ")) return raw.slice(colon + 2).trim() || t("files.error.gitFailed")
  return raw.trim() || t("files.error.gitFailed")
}

export type StatWidths = { added: number; deleted: number }

export function computeStatWidths(rows: readonly Row[]): StatWidths {
  let added = 0
  let deleted = 0
  for (const row of rows) {
    if (row.kind !== "status") continue
    if (row.added != null) added = Math.max(added, String(row.added).length + 1)
    if (row.deleted != null) deleted = Math.max(deleted, String(row.deleted).length + 1)
  }
  return { added, deleted }
}

export function computePathBudget(paneWidth: number, w: StatWidths): number {
  const stats = (w.added > 0 ? w.added + 1 : 0) + (w.deleted > 0 ? w.deleted + 1 : 0)
  return Math.max(8, paneWidth - 6 - stats)
}

export function statCell(value: number | null | undefined, width: number, sign: "+" | "-"): string {
  return value == null ? " ".repeat(width) : `${sign}${value}`.padStart(width)
}

export function toggleDir(expanded: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(expanded)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

export type NavAction = { type: "expand" | "collapse"; path: string } | { type: "cursor"; index: number }

export function expandOrDescendAction(rows: readonly Row[], cursorIndex: number): NavAction | null {
  const row = rows[cursorIndex]
  if (!row || row.kind !== "dir") return null
  if (!row.expanded && row.hasChildren) return { type: "expand", path: row.path }
  if (row.expanded && cursorIndex + 1 < rows.length) return { type: "cursor", index: cursorIndex + 1 }
  return null
}

export function collapseOrParentAction(rows: readonly Row[], cursorIndex: number): NavAction | null {
  const row = rows[cursorIndex]
  if (!row) return null
  if (row.kind === "dir" && row.expanded) return { type: "collapse", path: row.path }
  if (row.kind !== "dir" && row.kind !== "file") return null
  const targetDepth = row.depth - 1
  if (targetDepth < 0) return null
  for (let j = cursorIndex - 1; j >= 0; j--) {
    const candidate = rows[j]
    if (!candidate) continue
    if (candidate.kind === "dir" && candidate.depth === targetDepth) return { type: "cursor", index: j }
  }
  return null
}

export function followScrollTop(scrollTop: number, viewportHeight: number, cursorIndex: number): number | null {
  if (viewportHeight <= 0) return null
  if (cursorIndex < scrollTop) return cursorIndex
  if (cursorIndex >= scrollTop + viewportHeight) return cursorIndex - viewportHeight + 1
  return null
}

export function watchEventRelevant(filename: string): boolean {
  if (filename === ".git" || filename.startsWith(".git/") || filename.startsWith(".git\\")) return false
  if (filename.startsWith("node_modules/") || filename.startsWith("node_modules\\")) return false
  return true
}

type EventedWatcher = ReturnType<typeof watch> & { on(event: "error", listener: (err: Error) => void): void }

export function watchWorktree(path: string, onChange: () => void, debounceMs = 500): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let watcher: EventedWatcher | null = null
  try {
    watcher = watch(path, { recursive: true }, (_event, filename) => {
      if (filename == null) return
      if (!watchEventRelevant(filename.toString())) return
      if (debounceTimer != null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        onChange()
      }, debounceMs)
    }) as EventedWatcher
    watcher.on("error", () => {})
  } catch {}
  return () => {
    if (debounceTimer != null) clearTimeout(debounceTimer)
    if (watcher != null) watcher.close()
  }
}
