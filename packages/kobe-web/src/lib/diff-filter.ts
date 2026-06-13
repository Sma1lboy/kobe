/**
 * Filter a diff's file list by a path query — the Changes pane's file search,
 * kept pure + React-free so it's unit-testable. A blank query returns the SAME
 * array reference (so the filtered memo is a no-op when not searching).
 *
 * The query is one pattern, matched case-insensitively against each file path:
 *   - plain text        → substring match (`store` → any path containing it)
 *   - glob with `*`     → anchored wildcard (`*.test.ts`, `src/*`); `*` is `.*`
 *   - leading `!`       → negate (`!*.json` keeps everything that ISN'T json)
 */

import type { DiffFile } from "./diff.ts"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A `*`-glob anchored to the whole path; literal segments are escaped. */
function globToRegExp(glob: string): RegExp {
  const body = glob.split("*").map(escapeRegExp).join(".*")
  return new RegExp(`^${body}$`)
}

/**
 * Does one path match one pattern? Case-insensitive. A `!` prefix negates; a
 * `*` makes it an anchored glob; otherwise it's a substring test. An empty
 * pattern (or a bare `!`) matches everything (the negation of nothing).
 */
export function matchesPath(path: string, pattern: string): boolean {
  const negate = pattern.startsWith("!")
  const pat = (negate ? pattern.slice(1) : pattern).trim().toLowerCase()
  if (!pat) return true
  const lc = path.toLowerCase()
  const matched = pat.includes("*")
    ? globToRegExp(pat).test(lc)
    : lc.includes(pat)
  return negate ? !matched : matched
}

export function filterDiffFiles(
  files: readonly DiffFile[],
  query: string,
): readonly DiffFile[] {
  const q = query.trim()
  if (!q) return files
  return files.filter((f) => matchesPath(f.path, q))
}
