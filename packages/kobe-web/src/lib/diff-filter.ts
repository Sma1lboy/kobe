/**
 * Filter a diff's file list by a path substring — the Changes pane's file
 * search, kept pure + React-free so it's unit-testable. A blank query returns
 * the SAME array reference (so the filtered memo is a no-op when not
 * searching); otherwise it's a case-insensitive substring match on each file's
 * path.
 */

import type { DiffFile } from "./diff.ts"

export function filterDiffFiles(
  files: readonly DiffFile[],
  query: string,
): readonly DiffFile[] {
  const q = query.trim().toLowerCase()
  if (!q) return files
  return files.filter((f) => f.path.toLowerCase().includes(q))
}
