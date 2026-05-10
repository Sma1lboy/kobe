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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { kvStatePath } from "../env.ts"

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
 */
export function addSavedRepo(absPath: string): AddResult {
  const state = load()
  const cur = getSavedRepos()
  if (cur.includes(absPath)) {
    return { added: false, path: absPath, total: cur.length }
  }
  state.savedRepos = [...cur, absPath]
  save(state)
  return { added: true, path: absPath, total: cur.length + 1 }
}
