# Remote projects (SSH-backed)

> Status: **phases 1–5 done; Hosted PTY engine-launch parity requires revalidation; phases 7–8 remain.** Built phase-by-phase; see "Phases" + commit history.
> Remote registration and worktree creation exist, but the phase-6 engine launch was wired through the retired tmux runtime. The current standalone PTY Host path has not re-established or live-tested engine-over-SSH parity.
> This is the design source of truth for the review. Written from the read-only dive (`docs/` + git history).

## Goal

A kobe **project** (a saved repo, a `kind:"main"` task) can be **remote**: it carries SSH connection + a remote base path. A task created under a remote project:

- creates its git **worktree on the remote host** (the same `git worktree add` flow, run over SSH),
- should run the **engine (claude/codex) on the remote host** by having the local standalone PTY Host own an `ssh -tt … 'cd <remote-wt> && <engine>'` child, and
- proxies file tree / diff / changes chip / branch operations over SSH for a near-local feel.

The first item is implemented. The Hosted PTY session-launch builder does not yet consume the remote command-wrapping and local-cwd seams, so engine-over-SSH parity is currently pending rather than a shipped guarantee.

**The PureTUI Workspace Host, standalone PTY Host, and daemon stay LOCAL.** No remote kobe PTY Host is required; only the worktree and intended engine process live remotely.

This is NOT "small" (the dive rated every seam `moderate`): git is not funneled through one runner, several panes read the local fs directly, and SSH needs connection multiplexing + secure password storage. It IS coherent and seam-based — most of the change is "route this existing call through an ExecHost."

## The seam: `ExecHost`

Everything that runs a process or touches a file on the "worktree side" goes through an `ExecHost`:

```ts
interface ExecHost {
  // sync command — matches orchestrator/worktree/git.ts:git() verbatim
  run(argv: string[], opts?: { cwd?: string; env?: Record<string,string>; allowFail?: boolean }): { code: number; stdout: string; stderr: string }
  // async command (file-tree / diff panes already use async spawn)
  runAsync(argv: string[], opts?: …): Promise<{ code; stdout; stderr }>
  // fs helpers (manager + ops + history readers read fs directly, not only git)
  exists(path): boolean
  mkdir(path): void
  readFile(path): string | null
  readdir(path): string[]
  // for a Hosted PTY engine launch: wrap a command STRING to run on the host
  wrapCommand(remoteCommand: string, opts?: { tty?: boolean; cwd?: string }): string
}
```

- `LocalExecHost` — today's behavior verbatim (`spawnSync` / node `fs`). The default; zero regression for local tasks.
- `RemoteExecHost(spec)` — wraps argv as `ssh [-p port] [-i key] -o BatchMode=yes -o ControlMaster=auto -o ControlPath=<sock> -o ControlPersist=300 -o StrictHostKeyChecking=accept-new user@host -- sh -c '<cd cwd && quoted argv>'`; fs helpers map to `ssh … test -d / mkdir -p / cat / ls`. `wrapCommand` produces the `ssh -tt …` PTY launch line.

A task resolves its `ExecHost` **once** from its project's remote config: `execHostForRepo(repo)` → `remoteRepos[repo] ? RemoteExecHost(cfg) : LocalExecHost`. Remoteness is **derived** from `task.repo`, not stored as a Task bool (mirrors the `repoConfigs` init-override discipline).

### ControlMaster (load-bearing)

The sidebar polls `git status` / branch every 2s **per row**, the file tree refreshes, diffs open — over SSH each would be a fresh ~100-300ms handshake. So `RemoteExecHost` MUST reuse **one multiplexed SSH connection** per remote project via `ControlMaster=auto` + a `ControlPath` socket under `<KOBE_HOME>/.kobe/ssh/<host-user-port>.sock` + `ControlPersist`. First call opens the master; every later call opens a sub-channel (sub-ms). The socket lives under KOBE_HOME (like the daemon socket) so `kobe reset` cleans it.

## Data model

Stored in `state.json`, mirroring `repoConfigs`:

```ts
type RemoteAuth =
  | { kind: "key"; keyPath?: string }                 // keyPath null → ssh-agent / default identities
  | { kind: "password"; keychainRef: { service: string; account: string } }  // secret in OS keychain, NOT here

type RemoteRepoConfig = { host: string; user: string; port?: number; basePath: string; auth: RemoteAuth }
// remoteRepos[projectKey] = RemoteRepoConfig
```

- A remote project has **no local path**, so its `savedRepos` key is a synthetic `ssh://user@host:port/basePath`. `resolveRepoRoot`/`realpathSync` must be **bypassed** for `ssh://` keys (don't canonicalize a non-existent local path).
- `SerializedTask` gains an optional `remote?: { host; user; port }` echo (NO auth) so pane processes resolve their ExecHost off the wire without re-reading state.json.

## Auth + keychain (security rules — non-negotiable)

- **Password never lands in `state.json`, in the Hosted PTY launch command, or in `ps`/argv.** state.json holds only a `keychainRef`. The secret lives in the OS keychain.
- macOS keychain helper (greenfield — no existing kobe keychain code): `security add-generic-password -U -s <service> -a <account> -w` to store, `security find-generic-password -s … -a … -w` to read. DI-injected exec so tests don't touch the real keychain. (Linux `secret-tool` / Windows later; kobe is macOS-primary.)
- Password SSH via `sshpass -e` reading `SSHPASS` env (**never** `sshpass -p <pw>`). The password is read from the keychain and used **once** to bring up the ControlMaster master; the multiplexed socket then carries every channel with no re-auth.
- `sshpass` is **not** on macOS by default → surface a prerequisite check (don't fail opaquely).
- First-connect host key: `StrictHostKeyChecking=accept-new` (TOFU — accept unknown, **reject changed**), never `no`.
- **Prefer SSH keys.** Password is the constrained, more-fragile path.

## Phases (each its own commit, kept green)

**Phases 1–5 are DONE** (branch `remote-projects`). `kobe add --remote …` registers an SSH project and task creation materialises its worktree **on the remote**. Phase 6 originally launched the engine through the now-retired tmux runtime; the standalone Hosted PTY migration removed that integration path without revalidating an equivalent `ssh -tt … 'cd <wt> && <engine>'` launch. No live remote host has validated the current runtime path.

**Gated behind an experimental flag** (the whole feature is unfinished — see "Remaining" below). The `experimental.remoteProjects` boolean in `state.json` (off by default) is toggled at **Settings → Dev → Experimental → Remote projects**. `kobe add --remote` refuses with a pointer to that toggle when the flag is off (`isRemoteProjectsEnabled()` in `state/repos.ts`). Existing remote configuration and worktree routing remain readable while the flag is off, but engine launch must not be treated as parity-complete until the Hosted PTY path is reconnected and verified.

1. **ExecHost** ✅ — `exec/exec-host.ts`: `LocalExecHost` / `RemoteExecHost` / `RemoteSpec` + pure ssh construction (`sshConnectArgs`, `remoteShellCommand`, `shQuote`) + ControlMaster `ensureReady` (sshpass `-e` once). `exec/resolve.ts`: `execHostForRepo` / `execHostForWorktreePath` / `remoteSpecFromConfig`. Tests: `test/exec/exec-host.test.ts`.
2. **Keychain** ✅ — `exec/keychain.ts`: macOS `security` store/read/delete behind injected `KeychainDeps`, non-darwin degrades to no-op. Tests: `test/exec/keychain.test.ts`.
3. **Data model** ✅ — `state/repos.ts`: `RemoteRepoConfig` + `remoteRepos` map, synthetic `ssh://user@host[:port]` savedRepos key, `resolveRepoRoot` passes ssh:// through. `remoteControlSocketPath` in `env.ts`. Tests: `test/exec/remote-repos.test.ts`.
4. **CLI** ✅ — `cli/add-remote.ts`: `kobe add --remote --host --user --path [--port] [--key [path] | --password]`. Password prompted with echo off → keychain; best-effort connectivity probe. Tests: `test/cli/add-remote.test.ts`.
5. **Remote worktree** ✅ — `GitWorktreeManager` routes git + fs through an injected `WorktreeExecDeps`; remote worktrees live under `<basePath>/.kobe/worktrees`; `paths.ts` `remoteWorktreePathFor` + remote-aware `listWorktreeDirNames`. Tests: `test/orchestrator/worktree-remote.test.ts` + all 60 existing worktree tests still pass.
6. **Engine launch parity** ⚠️ — the retired tmux path used `wrapEngineLaunch` plus `localSpawnCwd` to keep the local child cwd valid while wrapping the remote engine in `ssh -tt`. The `ExecHost.wrapCommand`, `localSpawnCwd`, and remote-resolution helpers remain, but the current shared Hosted PTY session-launch path does not consume them. Reconnect this seam and cover initial launch, additional tabs, resume/reattach, and headless API delivery before marking parity complete.

### Remaining (not yet built)

7. **FS panes over SSH** — `filetree/git.ts`, sidebar `worktree-changes.ts` (the 2s sync poll must become **async + last-known cache** for remote — a sync SSH call would freeze the TUI; keep the sync fast-path for local), `git-head.ts`, ops diff/read (`Bun.file().text()` → `cat` over SSH). Until this lands, a remote task's Ops/file panes cannot provide local parity. The `ExecHost.readFile`/`run` seam is ready; the work is routing these pane readers through `execHostForWorktreePath(cwd)` and converting the sidebar chip to async.
8. **Deferred / v1-degrade** — **repo init script + first prompt on remote** (currently skipped for remote in `ensureSession` — they run locally today; the init must move inside the ssh command and the once-per-worktree marker must key on the remote worktree). Telemetry (auto-title / activity / cost read the engine transcript, which is on the **remote**; proxy via `HistoryDeps` or degrade like a custom engine). The web diff route. The new-task dialog remote tab + sidebar remote-project card (today a remote project is added only via `kobe add --remote`).

## Known traps (from the dive)

- **Every Hosted PTY launch path must use the same remote wrapper.** Initial engine launch, additional tabs, reattach/resume, and headless API startup must all route through `ExecHost.wrapCommand`; missing one can silently run the engine locally.
- **The PTY child's `cwd` is local.** A remote worktree path usually does not exist on the machine running the standalone PTY Host, so use `localSpawnCwd` locally while the SSH-wrapped command performs `cd <remoteWt>` on the remote host.
- **fs reads, not just git** — `manager.ts` (`existsSync`/`mkdirSync`/`statSync`/`realpathSync`), `ops/host.tsx` (`Bun.file().text()`), the history readers. A `run(argv)`-only ExecHost is insufficient; it needs fs helpers.
- **Sidebar polls are sync** (`spawnSync`, 2s) — cannot become a sync SSH call (freezes the TUI). Remote → async + cached.
- **Once-per-worktree init marker** lives under local `<home>/.kobe` but the init script runs remote — the gate semantics must key on the remote worktree, or remote init re-runs each launch.
