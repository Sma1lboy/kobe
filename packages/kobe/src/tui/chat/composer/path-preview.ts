/**
 * Composer path-preview helpers.
 *
 * The textarea itself is a plain text renderable, so clickable file
 * affordances are rendered beside it from the same buffer. This module
 * keeps the path detection pure and testable: only paths that already
 * exist in the active worktree's git file list are surfaced.
 */

export type PreviewablePathRef = {
  readonly path: string
  readonly index: number
}

const DEFAULT_LIMIT = 5

const BEFORE_BOUNDARY = new Set([" ", "\n", "\t", "\r", "(", "[", "{", "<", '"', "'", "`", "@"])
const AFTER_BOUNDARY = new Set([" ", "\n", "\t", "\r", ")", "]", "}", ">", '"', "'", "`", ".", ",", ";", ":", "!", "?"])

function hasStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return BEFORE_BOUNDARY.has(text[index - 1] ?? "")
}

function hasEndBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true
  const ch = text[index] ?? ""
  if (ch !== ".") return AFTER_BOUNDARY.has(ch)
  const next = text[index + 1]
  return next == null || [" ", "\n", "\t", "\r", ")", "]", "}", ">", '"', "'", "`"].includes(next)
}

/**
 * Find file paths from `files` that appear as standalone references in
 * `text`, ordered by where the user typed them. Longer paths are
 * searched first so `src/index.ts` wins over `index.ts` when both are
 * present in the file list.
 */
export function findPreviewablePathRefs(
  text: string,
  files: readonly string[],
  limit: number = DEFAULT_LIMIT,
): readonly PreviewablePathRef[] {
  if (limit <= 0) return []
  const trimmed = text.trim()
  if (!trimmed || files.length === 0) return []

  const matches: PreviewablePathRef[] = []
  const seen = new Set<string>()
  const sorted = [...files].filter((path) => path.length > 0).sort((a, b) => b.length - a.length)

  for (const path of sorted) {
    let from = 0
    while (from < text.length) {
      const index = text.indexOf(path, from)
      if (index < 0) break
      const end = index + path.length
      if (hasStartBoundary(text, index) && hasEndBoundary(text, end)) {
        if (!seen.has(path)) {
          seen.add(path)
          matches.push({ path, index })
        }
        break
      }
      from = index + 1
    }
  }

  matches.sort((a, b) => a.index - b.index || a.path.localeCompare(b.path))
  return matches.slice(0, limit)
}

export function formatPreviewPathLabel(path: string, maxCells: number): string {
  if (maxCells <= 3) return path.slice(0, Math.max(0, maxCells))
  if (path.length <= maxCells) return path

  const slash = path.lastIndexOf("/")
  const filename = slash >= 0 ? path.slice(slash + 1) : path
  if (filename.length + 4 <= maxCells) {
    const prefixCells = maxCells - filename.length - 4
    return `${path.slice(0, prefixCells)}.../${filename}`
  }

  const headCells = Math.max(1, Math.floor((maxCells - 3) / 2))
  const tailCells = Math.max(1, maxCells - 3 - headCells)
  return `${path.slice(0, headCells)}...${path.slice(path.length - tailCells)}`
}
