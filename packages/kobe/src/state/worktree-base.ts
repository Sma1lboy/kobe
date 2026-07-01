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
 * Normalize a raw user-entered base path to an absolute directory, or
 * `null` when it's unset/blank (meaning "use kobe's default root").
 *
 * A leading `~` / `~/` expands to the OS home; relative paths resolve
 * against it too, so a user who types `code/worktrees` gets a stable
 * absolute location instead of one that depends on kobe's cwd.
 */
export function normalizeWorktreeBase(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // homeDir() already falls back to os.homedir() when KOBE_HOME_DIR is unset.
  const home = homeDir()
  if (trimmed === "~") return home
  const expanded = trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(home, expanded)
}

/**
 * The configured worktree base override as an absolute path, or `null`
 * when unset. Read fresh from state.json on every call.
 */
export function getWorktreeBaseOverride(): string | null {
  const value = loadStateFile()[WORKTREE_BASE_KEY]
  return normalizeWorktreeBase(typeof value === "string" ? value : null)
}
