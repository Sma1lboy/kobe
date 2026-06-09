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

import { remoteControlSocketPath } from "../env.ts"
import { type RemoteRepoConfig, getRemoteRepoConfig, getRemoteRepos } from "../state/repos.ts"
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
