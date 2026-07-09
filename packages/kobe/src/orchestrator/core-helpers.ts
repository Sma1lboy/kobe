/**
 * Pure, `this`-independent helpers for the {@link Orchestrator} (`core.ts`).
 *
 * Path / repo-key normalisation with no orchestrator state — split out so the
 * class stays under the file-size cap. Moved verbatim from `core.ts`.
 */

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { isRemoteRepoKey, resolveRepoRoot } from "../state/repos.ts"

/**
 * Resolve symlinks so two strings naming the same node compare equal
 * (macOS `/var` → `/private/var`). Falls back to `resolve` when the path
 * doesn't exist. Used to de-dupe discovered worktrees against task paths,
 * which may be stored in different (caller vs git) forms.
 */
export function canonPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function titleFromRepo(repo: string): string {
  const segs = repo.split(/[/\\]/).filter(Boolean)
  return segs.length > 0 ? (segs[segs.length - 1] ?? repo) : repo
}

export function normalizeMainRepo(repo: string): { repo: string; key: string } {
  const normalized = resolveRepoRoot(repo)
  return {
    repo: normalized,
    key: isRemoteRepoKey(normalized) ? normalized : canonPath(normalized),
  }
}
