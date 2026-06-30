/**
 * Worktree base-path preference — the user-configurable directory that
 * replaces the default `<kobeStateDir>/worktrees` root for newly created
 * kobe worktrees.
 *
 * Two-process split (mirrors the editor-command setting):
 *   - the TUI WRITES it via the reactive `kv` store (a debounced patch
 *     into `~/.config/kobe/state.json`), and
 *   - the daemon/orchestrator READS it cross-process via {@link loadStateFile}
 *     when computing a new worktree's path in `orchestrator/worktree/paths.ts`.
 *
 * Both sides agree only on the key string {@link WORKTREE_BASE_PATH_KEY} and
 * the normalization in {@link normalizeWorktreeBasePath}, so the value is
 * stored exactly as the user typed it (`~`-relative paths display nicely)
 * and resolved to an absolute path only at read time. An empty/blank/
 * invalid value means "use the built-in default" — never a hard error, so
 * a fat-fingered relative path can't wedge task creation.
 */

import path from "node:path"
import { homeDir } from "../env.ts"
import { loadStateFile } from "./store.ts"

/** state.json key the TUI writes and the daemon reads. */
export const WORKTREE_BASE_PATH_KEY = "worktree.basePath"

/**
 * Expand a leading `~` / `~/...` to the user's home directory. We honor
 * kobe's {@link homeDir} (which respects `KOBE_HOME_DIR`) so an isolated
 * dev/test home expands consistently with every other kobe path. A bare
 * `~user` form is left untouched — we only special-case the current user.
 */
function expandHome(input: string): string {
  if (input === "~") return homeDir()
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(homeDir(), input.slice(2))
  }
  return input
}

/**
 * Resolve a raw stored value to an absolute base directory, or `undefined`
 * when it should fall back to the default. A value is usable only when it
 * is non-blank and resolves to an absolute path (after `~` expansion);
 * anything else (blank, relative, garbage) returns `undefined` so callers
 * keep the built-in default rather than rooting worktrees somewhere wrong.
 */
export function normalizeWorktreeBasePath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  const expanded = expandHome(trimmed)
  if (!path.isAbsolute(expanded)) return undefined
  const normalized = path.normalize(expanded)
  // Drop a trailing separator so the stored root joins cleanly and displays
  // consistently — but never strip a bare root ("/" or "C:\").
  if (normalized.length > 1 && (normalized.endsWith("/") || normalized.endsWith("\\"))) {
    const stripped = normalized.replace(/[/\\]+$/, "")
    return stripped === "" ? normalized : stripped
  }
  return normalized
}

/** True iff `raw` is a usable worktree base path (blank counts as "valid": means default). */
export function isValidWorktreeBasePath(raw: string): boolean {
  return raw.trim() === "" || normalizeWorktreeBasePath(raw) !== undefined
}

/**
 * The configured worktree base directory, resolved to an absolute path, or
 * `undefined` when unset/invalid. Reads `~/.config/kobe/state.json` FRESH on
 * every call (no cache) so a change the TUI just wrote is picked up by the
 * daemon on the next worktree creation — matching the snapshot-only,
 * no-file-watching contract the rest of kobe's state layer uses.
 */
export function getConfiguredWorktreeBase(): string | undefined {
  return normalizeWorktreeBasePath(loadStateFile()[WORKTREE_BASE_PATH_KEY])
}
