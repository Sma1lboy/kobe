/**
 * Global worktree base-path override.
 *
 * By default kobe stores every LOCAL task worktree under
 * `<home>/.kobe/worktrees/<repo-key>/<slug>` (see
 * `orchestrator/worktree/paths.ts`). This module owns the one optional
 * knob that relocates that `<home>/.kobe/worktrees` root to a
 * user-chosen directory — e.g. a faster disk, or a folder the user
 * already keeps their scratch checkouts in. The per-repo `<repo-key>`
 * namespacing below it is preserved, so worktrees from different repos
 * never collide under a shared base.
 *
 * The value may start with the `$project_dir` token, which expands to
 * the task's project root at path-computation time — one global setting
 * that yields a per-project layout (e.g. `$project_dir/../` puts the
 * worktrees root next to each project). The token is only recognized as
 * the leading path segment; anywhere else it is a literal directory name.
 *
 * Stored in the shared state.json (the Settings dialog's KV writes the
 * same file) and read FRESH on every worktree-path computation, so
 * changing it takes effect for the next task with no daemon restart.
 * Only NEW tasks move: existing tasks keep their persisted worktreePath,
 * and the old default root stays recognized for listing/slug allocation
 * (see `managedWorktreeRootsFor`).
 *
 * Remote (SSH) projects are unaffected — their worktrees live on the
 * remote host under the project's own `basePath` (`remoteWorktreeRootFor`).
 */

import { isAbsolute, join, resolve } from "node:path"
import { homeDir } from "../env.ts"
import { loadStateFile } from "./store.ts"

export const WORKTREE_BASE_KEY = "worktree.basePath"

/**
 * TUI-only companion key remembering the last custom path the user
 * typed, so cycling the setting away from `custom` and back restores it
 * instead of forcing a retype. The daemon never reads this.
 */
export const WORKTREE_BASE_CUSTOM_KEY = "worktree.basePath.custom"

/** Leading-segment token that expands to the task's project root. */
export const PROJECT_DIR_TOKEN = "$project_dir"

/**
 * The stored value behind the "next to project" preset: worktrees land
 * beside each repo (`<parent-of-repo>/<repo>-<hash>/<slug>`).
 */
export const PROJECT_SIBLING_BASE = `${PROJECT_DIR_TOKEN}/..`

export type WorktreeBaseKind = "default" | "nextToProject" | "custom"

/**
 * Classify a raw stored base path into the Settings presets: blank →
 * `default`, the `$project_dir/..` sibling preset (any trailing slashes
 * tolerated) → `nextToProject`, anything else → `custom`.
 */
export function worktreeBaseKindOf(raw: string): WorktreeBaseKind {
  const trimmed = raw.trim()
  if (!trimmed) return "default"
  if (trimmed.replace(/\/+$/, "") === PROJECT_SIBLING_BASE) return "nextToProject"
  return "custom"
}

/** True iff `raw` starts with `$project_dir` as its first path segment. */
export function hasProjectDirToken(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed === PROJECT_DIR_TOKEN || trimmed.startsWith(`${PROJECT_DIR_TOKEN}/`)
}

/**
 * Normalize a raw user-entered base path to an absolute directory, or
 * `null` when it's unset/blank (meaning "use kobe's default root").
 *
 * A leading `~` / `~/` expands to the OS home; relative paths resolve
 * against it too, so a user who types `code/worktrees` gets a stable
 * absolute location instead of one that depends on kobe's cwd.
 *
 * A leading `$project_dir` segment expands to `projectDir` (the repo
 * root of the task being created), with `..` segments collapsed — so
 * `$project_dir/../wt` lands next to each project. When the token is
 * present but no `projectDir` context exists (a global read with no
 * repo at hand), the result is `null`: fall back to the default root
 * rather than inventing a literal `$project_dir` directory.
 */
export function normalizeWorktreeBase(raw: string | undefined | null, projectDir?: string): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (hasProjectDirToken(trimmed)) {
    if (!projectDir) return null
    const rest = trimmed.slice(PROJECT_DIR_TOKEN.length).replace(/^\/+/, "")
    return resolve(projectDir, rest)
  }
  // homeDir() already falls back to os.homedir() when KOBE_HOME_DIR is unset.
  const home = homeDir()
  if (trimmed === "~") return home
  const expanded = trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

/**
 * The configured worktree base override as an absolute path, or `null`
 * when unset. Read fresh from state.json on every call. `projectDir`
 * (the repo root the path is being computed for) is required for a
 * `$project_dir` override to take effect — without it the token falls
 * back to the default root.
 */
export function getWorktreeBaseOverride(projectDir?: string): string | null {
  const value = loadStateFile()[WORKTREE_BASE_KEY]
  return normalizeWorktreeBase(typeof value === "string" ? value : null, projectDir)
}
