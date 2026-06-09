# Remote projects (SSH-backed)

> Status: **in progress** (branch `remote-projects`). Built phase-by-phase; see "Phases" + commit history.
> This is the design source of truth for the review. Written from the read-only dive (`docs/` + git history).

## Goal

A kobe **project** (a saved repo, a `kind:"main"` task) can be **remote**: it carries SSH connection + a remote base path. A task created under a remote project:

- creates its git **worktree on the remote host** (the same `git worktree add` flow, run over SSH), and
- runs the **engine (claude/codex) on the remote host** — the task's **local** tmux pane runs `ssh -t … 'cd <remote-wt> && <engine>'`. **No remote tmux server**; the engine runs in the SSH PTY the local pane holds.
- File tree / diff / changes chip / branch are **proxied over SSH** for a near-local feel.

**The TUI, the local tmux (`tmux -L kobe`), and the daemon stay LOCAL.** kobe orchestrates a remote repo's worktrees + engines over SSH; only the *work* happens remotely.

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
  // for the tmux launch path: wrap a command STRING to run on the host
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

- **Password never lands in `state.json`, in the tmux pane command, or in `ps`/argv.** state.json holds only a `keychainRef`. The secret lives in the OS keychain.
- macOS keychain helper (greenfield — no existing kobe keychain code): `security add-generic-password -U -s <service> -a <account> -w` to store, `security find-generic-password -s … -a … -w` to read. DI-injected exec so tests don't touch the real keychain. (Linux `secret-tool` / Windows later; kobe is macOS-primary.)
- Password SSH via `sshpass -e` reading `SSHPASS` env (**never** `sshpass -p <pw>`). The password is read from the keychain and used **once** to bring up the ControlMaster master; the multiplexed socket then carries every channel with no re-auth.
- `sshpass` is **not** on macOS by default → surface a prerequisite check (don't fail opaquely).
- First-connect host key: `StrictHostKeyChecking=accept-new` (TOFU — accept unknown, **reject changed**), never `no`.
- **Prefer SSH keys.** Password is the constrained, more-fragile path.

## Phases (each its own commit, kept green)

1. **ExecHost** — interface + `LocalExecHost` + `RemoteExecHost` + `RemoteSpec` + ssh argv/command construction + ControlMaster + `execHostForRepo` resolver. Unit-test the pure ssh-construction.
2. **Keychain helper** — macOS `security` store/read/delete, DI + tests.
3. **Data model** — `RemoteRepoConfig` in `state/repos.ts` (get/set, `ssh://` key handling), tests.
4. **CLI** — `kobe add --remote --host --user [--port] --path [--key <path> | --password]`.
5. **Remote worktree** — inject ExecHost into `GitWorktreeManager`; route its direct fs calls; branch `paths.ts` so a remote worktree root is under `basePath`; `ensureWorktree` resolves the ExecHost per repo.
6. **Engine launch** — `wrapForRemote(engineCmd, spec)` in `session-layout.ts`; thread `remote?` through `EnsureSessionOpts`; apply at the THREE launch points (`ensureSession` create, `relaunchEngineInAllWindows`, `newChatTab` via a new `@kobe_remote` session tag); local-cwd fallback for `-c`.
7. **FS panes over SSH** — `filetree/git.ts`, sidebar `worktree-changes.ts` (async + last-known cache for remote, keep sync fast-path for local), `git-head.ts`, ops diff/read.
8. **Deferred / v1-degrade** — telemetry (auto-title / activity / cost read the engine transcript, which is on the **remote**; proxy via the existing `HistoryDeps` seam or degrade like a custom engine), the web diff route, the new-task dialog remote tab + sidebar remote-project card, the once-per-worktree init marker semantics on remote.

## Known traps (from the dive)

- **Engine line is built in 3 places** in `tmux.ts` (only one uses `engineLaunchLine`). Miss one → a remote task silently runs the engine **locally** on respawn / in a new Ctrl+T tab. All three must ssh-wrap.
- **`-c <cwd>` is a remote path** for remote tasks — won't exist locally; tmux `new-session`/`split-window`/`respawn-pane` need a **local** cwd while the in-PTY `cd <remoteWt>` carries the real dir.
- **fs reads, not just git** — `manager.ts` (`existsSync`/`mkdirSync`/`statSync`/`realpathSync`), `ops/host.tsx` (`Bun.file().text()`), the history readers. A `run(argv)`-only ExecHost is insufficient; it needs fs helpers.
- **Sidebar polls are sync** (`spawnSync`, 2s) — cannot become a sync SSH call (freezes the TUI). Remote → async + cached.
- **Once-per-worktree init marker** lives under local `<home>/.kobe` but the init script runs remote — the gate semantics must key on the remote worktree, or remote init re-runs each launch.
