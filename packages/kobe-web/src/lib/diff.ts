/**
 * Diff fetch client — GET /api/diff?worktreePath=<abspath>.
 *
 * Mirrors the response shape of the bridge handler in
 * packages/kobe/src/web/diff.ts (handleDiffRequest). Kept here, not imported
 * from the kobe package, so no server code leaks into the client bundle.
 */

export interface DiffFile {
  /** Repo-relative path (post-rename path for renames). */
  path: string
  /** Human label: modified | added | deleted | renamed | untracked | … */
  status: string
  /** Change is in the index (vs. only the working tree). */
  staged: boolean
  /** Unified diff (`git diff`) for this file; synthesized all-added for untracked. */
  patch: string
}

export interface DiffResult {
  files: DiffFile[]
  /** Concatenated staged + unstaged raw diff (whole worktree). */
  raw: string
}

/** Fetch the working-tree changes for a worktree. Throws on a non-OK response. */
export async function fetchDiff(worktreePath: string): Promise<DiffResult> {
  const res = await fetch(`/api/diff?worktreePath=${encodeURIComponent(worktreePath)}`)
  const json = (await res.json()) as Partial<DiffResult> & { error?: string }
  if (!res.ok || json.error) {
    throw new Error(json.error ?? `diff fetch failed (${res.status})`)
  }
  return { files: json.files ?? [], raw: json.raw ?? "" }
}
