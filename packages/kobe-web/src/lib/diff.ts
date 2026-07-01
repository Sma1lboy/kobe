/**
 * Diff fetch client — GET /api/diff?worktreePath=<abspath>.
 *
 * Mirrors the response shape of the bridge handler in
 * packages/kobe/src/web/diff.ts (handleDiffRequest). Kept here, not imported
 * from the kobe package, so no server code leaks into the client bundle.
 */

import { api } from "./api-client.ts"

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
}

/** Options that narrow what the diff route has to compute server-side. */
export interface FetchDiffOptions {
  /**
   * Restrict the result to one repo-relative file. The route then only needs
   * that file's status + patch — not a patch for every untracked file in the
   * worktree (each of which is an extra `git diff --no-index` spawn).
   */
  path?: string
  /**
   * Ask for file names/statuses only and skip per-file patch assembly. Used by
   * the CHANGES list, which renders only names + badges. Patches come back as
   * empty strings.
   */
  namesOnly?: boolean
}

/**
 * Fetch the working-tree changes for a worktree. Throws on a non-OK response.
 *
 * `opts.path` / `opts.namesOnly` are query hints that let the bridge skip the
 * expensive per-untracked-file `git diff --no-index` spawns. They are
 * forward-compatible: a bridge that doesn't understand them simply returns the
 * full payload, which every caller already filters down to what it renders.
 */
export async function fetchDiff(
  worktreePath: string,
  opts: FetchDiffOptions = {},
): Promise<DiffResult> {
  const json = await api.get<Partial<DiffResult>>("/api/diff", {
    query: {
      worktreePath,
      path: opts.path,
      namesOnly: opts.namesOnly ? "1" : undefined,
    },
    label: "diff fetch",
  })
  return { files: json.files ?? [] }
}
