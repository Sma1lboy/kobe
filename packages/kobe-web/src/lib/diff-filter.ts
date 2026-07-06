import type { DiffFile } from "./diff.ts"

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob: string): RegExp {
  const body = glob.replace(/\*+/g, "*").split("*").map(escapeRegExp).join(".*")
  return new RegExp(`^${body}$`)
}

export function matchesPath(path: string, pattern: string): boolean {
  const trimmed = pattern.trim()
  const negate = trimmed.startsWith("!")
  const pat = (negate ? trimmed.slice(1) : trimmed).trim().toLowerCase()
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
