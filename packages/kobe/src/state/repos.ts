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
 * Concurrency note: all writes go through `src/state/store.ts`, whose
 * read-merge-write transactions keep concurrent writers (the TUI's
 * debounced flush, other panes' `setPersisted*` calls, a `kobe add` from
 * another shell) from erasing each other's keys. A running TUI's
 * in-memory cache still won't reflect an external addition until restart
 * — acceptable; there's deliberately no file watching.
 */

import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { kvStatePath } from "../env.ts"
import { type StateSnapshot, loadStateFile, patchStateFile, updateStateFile } from "./store.ts"

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
  // A remote project's key is a synthetic `ssh://…` URL, not a local path —
  // there is nothing to canonicalize (and no local git repo to ask). Pass it
  // through untouched so it round-trips as the stable savedRepos key.
  if (isRemoteRepoKey(absPath)) return absPath
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
 * Where the shared KV blob lives. Resolved on each access so a test's
 * `KOBE_HOME_DIR` override works without module-init reload tricks.
 */
export function statePath(): string {
  return kvStatePath()
}

/** `savedRepos` as stored in an already-loaded snapshot (type-filtered). */
function readSavedRepos(state: StateSnapshot): readonly string[] {
  const raw = state.savedRepos
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string")
}

export function getSavedRepos(): readonly string[] {
  return readSavedRepos(loadStateFile())
}

/**
 * Read a string value from the shared kv state.json. For standalone
 * processes (the `kobe tasks` pane) that need a kv value but don't host
 * the TUI's reactive `useKV` — e.g. `lastSelectedVendor`. Returns
 * `undefined` when absent or non-string. Atomic read.
 */
export function getPersistedString(key: string): string | undefined {
  const value = loadStateFile()[key]
  return typeof value === "string" ? value : undefined
}

/**
 * Persist a string value into the shared kv state.json: a single-key
 * read-merge-write + atomic rename via {@link patchStateFile}. Pairs with
 * {@link getPersistedString} for standalone processes. Concurrent with the
 * TUI's `useKV` writes, but both merge only the keys they changed, so a
 * write here can't be clobbered by (or clobber) a sibling key from another
 * process — last write wins only on the SAME key.
 */
export function setPersistedString(key: string, value: string): void {
  patchStateFile({ [key]: value })
}

/**
 * The ids of user-registered custom engines (KOB — user-addable engines).
 * Stored under the shared state.json `customEngineIds` key as a `string[]`;
 * each id's display name + launch command live in the SAME flat keys the
 * built-ins use (`engineName.<id>` / `engineCommand.<id>`), so Settings →
 * Engines manages built-in and custom engines through one mechanism. Read
 * cross-process (the new-task selector, the ctrl+T prompt) via this atomic
 * loader; written by the Settings dialog through its reactive kv. Built-in
 * ids are never present here.
 */
export function getCustomEngineIds(): readonly string[] {
  const raw = loadStateFile().customEngineIds
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
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
  // Resolve BEFORE the transaction — `git rev-parse` (a subprocess) inside
  // the read-merge-write window would widen the race we're trying to keep
  // narrow.
  const normalized = resolveRepoRoot(absPath)
  let result: AddResult = { added: false, path: normalized, total: 0 }
  updateStateFile((state) => {
    const cur = readSavedRepos(state)
    if (cur.includes(normalized)) {
      result = { added: false, path: normalized, total: cur.length }
      return false // already present — leave the file untouched
    }
    state.savedRepos = [...cur, normalized]
    result = { added: true, path: normalized, total: cur.length + 1 }
    return undefined
  })
  return result
}

/**
 * One-shot migration: rewrite the on-disk `savedRepos` list so each
 * entry is its git toplevel. Heals state files written before
 * {@link addSavedRepo} normalized at write time. Duplicates that
 * collapse to the same toplevel are de-duped. No-op when every entry
 * is already canonical.
 */
export function normalizeSavedRepos(): void {
  // Resolve toplevels first (subprocess per entry), THEN merge the result
  // in one short read-merge-write so the git calls don't sit inside the
  // transaction window.
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
  patchStateFile({ savedRepos: next })
}

/**
 * Per-user, per-repo init override stored under the `repoConfigs` key of
 * the shared state.json. This is the FALLBACK default for a repo that does
 * not ship its own `.kobe/init.sh` / `.kobe/init-prompt.md` — the in-repo
 * files win (see {@link ../state/repo-init.ts resolveRepoInit}). Keyed by
 * git toplevel so every worktree of the repo resolves the same entry.
 */
export interface RepoInitOverride {
  readonly initScript?: string
  readonly initPrompt?: string
}

function readRepoConfigs(state: StateSnapshot): Record<string, RepoInitOverride> {
  const raw = state.repoConfigs
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Record<string, RepoInitOverride>
}

function coerceOverride(entry: unknown): RepoInitOverride {
  if (!entry || typeof entry !== "object") return {}
  const e = entry as Record<string, unknown>
  return {
    initScript: typeof e.initScript === "string" && e.initScript.length > 0 ? e.initScript : undefined,
    initPrompt: typeof e.initPrompt === "string" && e.initPrompt.length > 0 ? e.initPrompt : undefined,
  }
}

/** Read the per-user state.json override for a repo (by git toplevel). */
export function getRepoInitOverride(repoRoot: string): RepoInitOverride {
  return coerceOverride(readRepoConfigs(loadStateFile())[resolveRepoRoot(repoRoot)])
}

/**
 * Patch a repo's init override. A field set to `""` clears that field; a
 * field left `undefined` is preserved. When both fields end up empty the
 * repo's entry is dropped entirely so state.json stays tidy.
 */
export function setRepoInitOverride(repoRoot: string, patch: RepoInitOverride): RepoInitOverride {
  const normalized = resolveRepoRoot(repoRoot)
  let next: RepoInitOverride = {}
  updateStateFile((state) => {
    const configs = { ...readRepoConfigs(state) }
    const cur = coerceOverride(configs[normalized])
    const nextScript = patch.initScript === undefined ? cur.initScript : patch.initScript || undefined
    const nextPrompt = patch.initPrompt === undefined ? cur.initPrompt : patch.initPrompt || undefined
    next = {
      ...(nextScript ? { initScript: nextScript } : {}),
      ...(nextPrompt ? { initPrompt: nextPrompt } : {}),
    }
    if (!next.initScript && !next.initPrompt) {
      const { [normalized]: _dropped, ...rest } = configs
      state.repoConfigs = rest
    } else {
      configs[normalized] = next
      state.repoConfigs = configs
    }
    return undefined
  })
  return next
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
  let result: RemoveResult = { removed: false, path: absPath, total: 0 }
  updateStateFile((state) => {
    const cur = readSavedRepos(state)
    if (!cur.includes(absPath)) {
      result = { removed: false, path: absPath, total: cur.length }
      return false // nothing to remove — leave the file untouched
    }
    state.savedRepos = cur.filter((p) => p !== absPath)
    result = { removed: true, path: absPath, total: cur.length - 1 }
    return undefined
  })
  return result
}

// ── Remote projects (SSH-backed) ─────────────────────────────────────────────
//
// A remote project is a saved repo whose worktrees + engine live on another
// host over SSH. Its `savedRepos` key is a synthetic `ssh://user@host:port`
// URL (it has no local path), and its connection details live under the
// separate `remoteRepos` map. The PASSWORD is never stored here — only a
// `keychainRef` pointing at the OS keychain (see `exec/keychain.ts`). See
// `docs/design/remote-projects.md`.

/** Persisted auth: a key path, or a pointer to a keychain-stored password. */
export type RemoteAuthConfig =
  | { readonly kind: "key"; readonly keyPath?: string }
  | { readonly kind: "password"; readonly keychainRef: { readonly service: string; readonly account: string } }

export interface RemoteRepoConfig {
  readonly host: string
  readonly user: string
  readonly port?: number
  /** The directory on the remote under which task worktrees are created. */
  readonly basePath: string
  readonly auth: RemoteAuthConfig
}

/** True for a synthetic remote-project key (`ssh://…`). */
export function isRemoteRepoKey(key: string): boolean {
  return key.startsWith("ssh://")
}

/**
 * Whether the experimental SSH-backed remote-projects feature is enabled
 * (Settings → Dev → Experimental). Off by default. Stored as a boolean under
 * the shared state.json `experimental.remoteProjects` key (written by the
 * Settings dialog's reactive kv); read here cross-process so `kobe add
 * --remote` can refuse when the feature is off. See `docs/design/remote-projects.md`.
 */
export function isRemoteProjectsEnabled(): boolean {
  return loadStateFile()["experimental.remoteProjects"] === true
}

/** The stable savedRepos key for a remote project: `ssh://user@host[:port]`. */
export function remoteRepoKey(host: string, user: string, port?: number): string {
  return port ? `ssh://${user}@${host}:${port}` : `ssh://${user}@${host}`
}

function readRemoteRepos(state: StateSnapshot): Record<string, RemoteRepoConfig> {
  const raw = state.remoteRepos
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Record<string, RemoteRepoConfig>
}

/** Read a remote project's connection config, or null when the key isn't remote. */
export function getRemoteRepoConfig(key: string): RemoteRepoConfig | null {
  return readRemoteRepos(loadStateFile())[key] ?? null
}

/** All remote-project configs, keyed by their `ssh://` savedRepos key. */
export function getRemoteRepos(): Readonly<Record<string, RemoteRepoConfig>> {
  return readRemoteRepos(loadStateFile())
}

/**
 * Register a remote project: store its config under `remoteRepos[key]` AND add
 * the synthetic key to `savedRepos` so it shows up as a project. Idempotent on
 * the savedRepos side; the config is overwritten so re-adding updates it.
 */
export function addRemoteRepo(config: RemoteRepoConfig): { key: string; added: boolean } {
  const key = remoteRepoKey(config.host, config.user, config.port)
  let added = false
  updateStateFile((state) => {
    const repos = { ...readRemoteRepos(state) }
    repos[key] = config
    state.remoteRepos = repos
    const saved = readSavedRepos(state)
    added = !saved.includes(key)
    if (added) state.savedRepos = [...saved, key]
    return undefined
  })
  return { key, added }
}
