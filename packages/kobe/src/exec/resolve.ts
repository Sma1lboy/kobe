/**
 * Resolve an `ExecHost` for a repo (project) key.
 *
 * A LOCAL project (an ordinary path) → `LocalExecHost` (today's behavior). A
 * REMOTE project (`ssh://…` key with a `remoteRepos` entry) → `RemoteExecHost`
 * wired to its host/user/port, the ControlMaster socket under KOBE_HOME, and
 * the keychain-backed password (read lazily, never persisted in state.json).
 *
 * Remoteness is DERIVED from the repo key, never stored on the Task — mirrors
 * the `repoConfigs` init-override discipline.
 */

import { homeDir, remoteControlSocketPath } from "../env.ts"
import { type RemoteRepoConfig, getRemoteRepoConfig, getRemoteRepos, isRemoteRepoKey } from "../state/repos.ts"
import { type ExecHost, LocalExecHost, type RemoteAuth, RemoteExecHost, type RemoteSpec } from "./exec-host.ts"
import { getKeychainPassword } from "./keychain.ts"

/** Build the runtime `RemoteSpec` (with a live password getter) from persisted config. */
export function remoteSpecFromConfig(config: RemoteRepoConfig): RemoteSpec {
  const cfgAuth = config.auth
  const auth: RemoteAuth =
    cfgAuth.kind === "key"
      ? { kind: "key", keyPath: cfgAuth.keyPath }
      : { kind: "password", getPassword: () => getKeychainPassword(cfgAuth.keychainRef) }
  return {
    host: config.host,
    user: config.user,
    port: config.port,
    auth,
    controlPath: remoteControlSocketPath(config.host, config.user, config.port),
  }
}

/**
 * The ExecHost for a project key. Defaults to local; only an `ssh://` key with
 * a stored `remoteRepos` config produces a `RemoteExecHost`. An `ssh://` key
 * with no config (corrupt state) falls back to local rather than throwing —
 * the caller surfaces the missing-config error elsewhere.
 */
export function execHostForRepo(repoKey: string): ExecHost {
  const config = getRemoteRepoConfig(repoKey)
  if (!config) return new LocalExecHost()
  return new RemoteExecHost(remoteSpecFromConfig(config))
}

/**
 * The ExecHost for a WORKTREE path (a path, not a project key). The
 * worktree-side manager methods (`isDirty`, `currentBranch`, `remove`, …)
 * receive only a path, so remoteness is recovered by matching the path
 * against each remote project's `basePath`. A local path matches nothing and
 * gets a `LocalExecHost` — zero regression for local tasks.
 */
export function execHostForWorktreePath(worktreePath: string): ExecHost {
  for (const config of Object.values(getRemoteRepos())) {
    if (worktreePath === config.basePath || worktreePath.startsWith(`${config.basePath}/`)) {
      return new RemoteExecHost(remoteSpecFromConfig(config))
    }
  }
  return new LocalExecHost()
}

// ── Intent-named queries (the remoteness conditionals live HERE, once) ──────
//
// Callers around session/spawn code used to derive remoteness themselves
// (`isRemoteRepoKey(task.repo) ? task.repo : undefined`, `.isRemote ||
// existsSync(...)`, `.isRemote ? homeDir() : cwd`). These helpers own those
// derivations so TUI/pane/CLI code asks intent-shaped questions and a third
// adapter only needs changes inside `exec/`.

/**
 * A task's remote-project key (`ssh://…`), or `undefined` for a local repo.
 * THE one place "is this task's repo remote?" is derived from a repo key —
 * callers hand `task.repo` to the session/spawn seams as-is instead of
 * computing this ternary per call site.
 */
export function remoteKeyForRepo(repo: string | undefined): string | undefined {
  return repo && isRemoteRepoKey(repo) ? repo : undefined
}

/**
 * Whether a worktree path is usable as a session cwd. A REMOTE worktree lives
 * on another host, so a local `existsSync` would (wrongly) say "missing" and
 * block opening the task — for a remote path we trust it exists remotely (the
 * orchestrator created it over SSH, and probing here would cost an SSH
 * round-trip per render). Local paths keep the real on-disk check.
 */
export function worktreeUsable(worktreePath: string): boolean {
  const host = execHostForWorktreePath(worktreePath)
  // `isRemote` short-circuits BEFORE `existsSync` — the sync probe is only
  // ever evaluated for a LOCAL host (cheap fs.existsSync); a remote host's
  // existsSync would be a blocking ssh round-trip and must not run here.
  return host.isRemote || host.existsSync(worktreePath)
}

/**
 * The LOCAL directory a pane/process serving a worktree can be spawned in
 * (tmux `-c`). For a LOCAL task this is the worktree itself. For a REMOTE
 * task the worktree path lives on another host and can't be `cd`'d locally —
 * tmux would refuse to spawn — so panes spawn in the local home dir while the
 * engine pane's wrapped `ssh … 'cd <wt>'` carries the real remote dir. Pure
 * for local paths → zero regression.
 */
export function localSpawnCwd(worktreePath: string): string {
  return execHostForWorktreePath(worktreePath).isRemote ? homeDir() : worktreePath
}
