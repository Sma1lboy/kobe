/**
 * Saved-repos persistence.
 *
 * The TUI's `KV` store (src/tui/context/kv.tsx) is a Solid-context wrapper
 * around `~/.config/kobe/state.json`. Outside that context — e.g. from the
 * `kobe add` CLI subcommand — we can't use it. This module is the
 * non-reactive direct accessor for the same on-disk blob: load, mutate,
 * atomic-rename save.
 *
 * The file format is shared with the TUI KV: a flat JSON object whose
 * `savedRepos` key is a `string[]` of repo paths the user has explicitly
 * added. The TUI reads it via `kv.get("savedRepos", [])`; this module
 * reads/writes the same key directly.
 *
 * Concurrency note: kobe assumes a single instance per user. If the TUI
 * is running and `kobe add` is invoked from another shell, the TUI's
 * in-memory cache won't reflect the addition until restart. Acceptable
 * for v1; a real flock comes with multi-instance support later.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"

/**
 * Resolve `absPath` to the git toplevel that owns it. A "main" task's
 * worktreePath must equal the git repo root because FileTree's
 * `git ls-files --full-name` emits paths relative to the toplevel, not
 * the cwd — saving a subdirectory (e.g. `packages/kobe`) makes the
 * tree render rooted at the monorepo root (`packages/...`) while the
 * task label still claims the subdir, confusing the user.
 *
 * Falls back to `absPath` itself when:
 *   - the directory isn't inside a git repo (rev-parse exits non-zero), or
 *   - the input already points at the toplevel (compared by realpath, so
 *     `/var/folders/...` is treated as equal to `/private/var/folders/...`
 *     on macOS rather than being rewritten to the canonical form).
 */
export function resolveRepoRoot(absPath: string): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: absPath,
    encoding: "utf8",
    shell: false,
  })
  if (r.status !== 0) return absPath
  const top = (r.stdout ?? "").trim()
  if (!top) return absPath
  try {
    if (realpathSync(absPath) === realpathSync(top)) return absPath
  } catch {
    // realpath can fail on broken symlinks / vanished dirs — fall
    // through and use the toplevel string as-is.
  }
  return top
}

/**
 * Whether two paths resolve to the same git toplevel. Used to identify
 * duplicate main-task rows whose `repo` strings differ (subdir vs
 * toplevel, `/var/...` vs `/private/var/...` on macOS, …) but point at
 * the same checkout. String-equality across `resolveRepoRoot` outputs
 * is unsafe because the helper preserves the caller's prefix when the
 * input is already canonical — two callers can therefore get different
 * strings for the same physical directory. Comparing realpaths of the
 * resolved toplevels is the canonical check.
 */
export function sameRepoToplevel(a: string, b: string): boolean {
  if (a === b) return true
  const topA = resolveRepoRoot(a)
  const topB = resolveRepoRoot(b)
  if (topA === topB) return true
  try {
    return realpathSync(topA) === realpathSync(topB)
  } catch {
    return false
  }
}

/**
 * Where the shared KV blob lives. Resolved on each access so a test's
 * `KOBE_HOME_DIR` override works without module-init reload tricks.
 */
export function statePath(): string {
  return kvStatePath()
}

function load(): Record<string, unknown> {
  try {
    const text = readFileSync(statePath(), "utf8")
    const parsed = JSON.parse(text) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Missing file or malformed JSON: start fresh.
  }
  return {}
}

function save(state: Record<string, unknown>): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
  renameSync(tmp, path)
}

export function getSavedRepos(): readonly string[] {
  const state = load()
  const raw = state.savedRepos
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string")
}

export type AddResult = { added: boolean; path: string; total: number }

/**
 * Append `absPath` to `savedRepos` if not already present.
 * Returns whether the entry was newly added and the resulting list size.
 *
 * The input is resolved to its git toplevel before storage (see
 * {@link resolveRepoRoot}) — so `kobe add` from a monorepo subdirectory
 * stores the repo root, not the subdir. The returned `path` is the
 * normalized form so callers report what was actually saved.
 */
export function addSavedRepo(absPath: string): AddResult {
  const normalized = resolveRepoRoot(absPath)
  const state = load()
  const cur = getSavedRepos()
  if (cur.includes(normalized)) {
    return { added: false, path: normalized, total: cur.length }
  }
  state.savedRepos = [...cur, normalized]
  save(state)
  return { added: true, path: normalized, total: cur.length + 1 }
}

/**
 * One-shot migration: rewrite the on-disk `savedRepos` list so each
 * entry is its git toplevel. Heals state files written before
 * {@link addSavedRepo} normalized at write time. Duplicates that
 * collapse to the same toplevel are de-duped. No-op when every entry
 * is already canonical.
 */
export function normalizeSavedRepos(): void {
  const state = load()
  const cur = getSavedRepos()
  const seen = new Set<string>()
  const next: string[] = []
  let changed = false
  for (const p of cur) {
    const top = resolveRepoRoot(p)
    if (top !== p) changed = true
    if (seen.has(top)) {
      changed = true
      continue
    }
    seen.add(top)
    next.push(top)
  }
  if (!changed) return
  state.savedRepos = next
  save(state)
}

export type RemoveResult = { removed: boolean; path: string; total: number }

/**
 * Remove `absPath` from `savedRepos`. KOB-15 wires this from the
 * sidebar's `d` keypress on a main-task row: the confirm copy is
 * "this will remove '<repo>' from your saved repos. The directory and
 * its files stay on disk." The directory itself is never touched —
 * only the saved-repos list is mutated. Sibling KV keys (themes,
 * lastSelectedTaskId, etc.) are preserved.
 *
 * Idempotent: removing a path that isn't in the list returns
 * `removed: false` and leaves the file untouched.
 */
export function removeSavedRepo(absPath: string): RemoveResult {
  const state = load()
  const cur = getSavedRepos()
  if (!cur.includes(absPath)) {
    return { removed: false, path: absPath, total: cur.length }
  }
  state.savedRepos = cur.filter((p) => p !== absPath)
  save(state)
  return { removed: true, path: absPath, total: cur.length - 1 }
}
