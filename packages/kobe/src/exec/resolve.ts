import { existsSync } from "node:fs"
import { homeDir, remoteControlSocketPath } from "../env.ts"
import { type RemoteRepoConfig, getRemoteRepoConfig, getRemoteRepos, isRemoteRepoKey } from "../state/repos.ts"
import { type ExecHost, LocalExecHost, type RemoteAuth, RemoteExecHost, type RemoteSpec } from "./exec-host.ts"
import { getKeychainPassword } from "./keychain.ts"

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

export function execHostForRepo(repoKey: string): ExecHost {
  const config = getRemoteRepoConfig(repoKey)
  if (!config) return new LocalExecHost()
  return new RemoteExecHost(remoteSpecFromConfig(config))
}

export function execHostForWorktreePath(worktreePath: string): ExecHost {
  for (const config of Object.values(getRemoteRepos())) {
    if (worktreePath === config.basePath || worktreePath.startsWith(`${config.basePath}/`)) {
      return new RemoteExecHost(remoteSpecFromConfig(config))
    }
  }
  return new LocalExecHost()
}

export function remoteKeyForRepo(repo: string | undefined): string | undefined {
  return repo && isRemoteRepoKey(repo) ? repo : undefined
}

export function worktreeUsable(worktreePath: string): boolean {
  return execHostForWorktreePath(worktreePath).isRemote || existsSync(worktreePath)
}

export function localSpawnCwd(worktreePath: string): string {
  return execHostForWorktreePath(worktreePath).isRemote ? homeDir() : worktreePath
}
