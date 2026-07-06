import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { kvStatePath } from "../env.ts"
import { type StateSnapshot, getPersistedBool, loadStateFile, patchStateFile, updateStateFile } from "./store.ts"

export function resolveRepoRoot(absPath: string): string {
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
  } catch {}
  return top
}

export function isGitRepo(absPath: string): boolean {
  if (isRemoteRepoKey(absPath)) return false
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: absPath,
    encoding: "utf8",
    shell: false,
  })
  return r.status === 0 && (r.stdout ?? "").trim() === "true"
}

export function resolveMainRepoRoot(absPath: string): string {
  if (isRemoteRepoKey(absPath)) return absPath
  const r = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: absPath,
    encoding: "utf8",
    shell: false,
  })
  if (r.status !== 0) return resolveRepoRoot(absPath)
  const first = (r.stdout ?? "")
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim()
  return first || resolveRepoRoot(absPath)
}

export function statePath(): string {
  return kvStatePath()
}

function readSavedRepos(state: StateSnapshot): readonly string[] {
  const raw = state.savedRepos
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string")
}

export function getSavedRepos(): readonly string[] {
  return readSavedRepos(loadStateFile())
}

export function getPersistedString(key: string): string | undefined {
  const value = loadStateFile()[key]
  return typeof value === "string" ? value : undefined
}

export function setPersistedString(key: string, value: string): void {
  patchStateFile({ [key]: value })
}

export function getCustomEngineIds(): readonly string[] {
  const raw = loadStateFile().customEngineIds
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
}

export type AddResult = { added: boolean; path: string; total: number }

export function addSavedRepo(absPath: string): AddResult {
  const normalized = resolveRepoRoot(absPath)
  let result: AddResult = { added: false, path: normalized, total: 0 }
  updateStateFile((state) => {
    const cur = readSavedRepos(state)
    if (cur.includes(normalized)) {
      result = { added: false, path: normalized, total: cur.length }
      return false
    }
    state.savedRepos = [...cur, normalized]
    result = { added: true, path: normalized, total: cur.length + 1 }
    return undefined
  })
  return result
}

export function normalizeSavedRepos(): void {
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

export function getRepoInitOverride(repoRoot: string): RepoInitOverride {
  return coerceOverride(readRepoConfigs(loadStateFile())[resolveRepoRoot(repoRoot)])
}

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

export function removeSavedRepo(absPath: string): RemoveResult {
  let result: RemoveResult = { removed: false, path: absPath, total: 0 }
  updateStateFile((state) => {
    const cur = readSavedRepos(state)
    if (!cur.includes(absPath)) {
      result = { removed: false, path: absPath, total: cur.length }
      return false
    }
    state.savedRepos = cur.filter((p) => p !== absPath)
    if (isRemoteRepoKey(absPath)) {
      const remotes = readRemoteRepos(state)
      if (absPath in remotes) {
        const next = { ...remotes }
        delete next[absPath]
        state.remoteRepos = next
      }
    }
    result = { removed: true, path: absPath, total: cur.length - 1 }
    return undefined
  })
  return result
}

export type RemoteAuthConfig =
  | { readonly kind: "key"; readonly keyPath?: string }
  | { readonly kind: "password"; readonly keychainRef: { readonly service: string; readonly account: string } }

export interface RemoteRepoConfig {
  readonly host: string
  readonly user: string
  readonly port?: number
  readonly basePath: string
  readonly auth: RemoteAuthConfig
}

export function isRemoteRepoKey(key: string): boolean {
  return key.startsWith("ssh://")
}

export function isRemoteProjectsEnabled(): boolean {
  return getPersistedBool("experimental.remoteProjects", false)
}

export function remoteRepoKey(host: string, user: string, port?: number): string {
  return port ? `ssh://${user}@${host}:${port}` : `ssh://${user}@${host}`
}

function readRemoteRepos(state: StateSnapshot): Record<string, RemoteRepoConfig> {
  const raw = state.remoteRepos
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  return raw as Record<string, RemoteRepoConfig>
}

export function getRemoteRepoConfig(key: string): RemoteRepoConfig | null {
  return readRemoteRepos(loadStateFile())[key] ?? null
}

export function getRemoteRepos(): Readonly<Record<string, RemoteRepoConfig>> {
  return readRemoteRepos(loadStateFile())
}

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
