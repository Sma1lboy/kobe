/**
 * ExecHost — the local/remote execution seam for remote projects.
 *
 * Everything kobe runs on the "worktree side" (git, fs reads, the engine
 * launch) goes through an ExecHost so a REMOTE project runs the exact same
 * logic over SSH while a LOCAL project keeps today's behavior verbatim:
 *
 *   - LocalExecHost  — async `spawn` + node `fs` (the default; zero regression).
 *   - RemoteExecHost — wraps every command in `ssh … 'cd <cwd> && <cmd>'`,
 *     reusing ONE multiplexed connection per remote project (ControlMaster).
 *
 * A task resolves its ExecHost once from its project's remote config (see
 * `state/repos.ts` remoteRepos). See `docs/design/remote-projects.md`.
 *
 * Blocking discipline (KOB — daemon event-loop freeze):
 *   The DAEMON runs worktree git operations through this seam. A
 *   `git worktree add` on a big repo is a minutes-long checkout, and a remote
 *   call is an ssh round-trip — neither may freeze the daemon's event loop
 *   (every TUI client's RPCs and pushes stall while it's blocked). So the
 *   members that do real work are ASYNC:
 *
 *     - `run` / `exists` / `mkdirp` / `readFile` / `readdir` → Promise-based,
 *       backed by async `spawn` locally and an async ssh spawn remotely.
 *
 *   The cheap/metadata members stay sync:
 *
 *     - `isRemote`, `wrapCommand` (pure string building), and `ensureReady`
 *       (ControlMaster bring-up; sync ssh, see caveat below).
 *
 *   (A sync existence probe used to live here, but its only caller —
 *   `worktreeUsable` — short-circuits on `isRemote` and so only ever needs a
 *   LOCAL check; it now calls `fs.existsSync` directly, and no remote sync
 *   existence round-trip exists.)
 *
 *   `ensureReady()` remains sync: it's called from TUI processes
 *   (tmux engine launch) and from `RemoteExecHost.run`'s first call per host
 *   instance. That first ControlMaster bring-up is the one remaining sync ssh
 *   on the daemon path (experimental remote-projects; tracked, not fixed here).
 *
 * Security (non-negotiable, see the design doc):
 *   - The password is NEVER in the command string, in `state.json`, or in
 *     `ps`/argv. It is read from the OS keychain into the `SSHPASS` env and
 *     used by `sshpass -e` ONLY to bring up the ControlMaster master once;
 *     every later call reuses the multiplexed socket with no auth, so the
 *     engine-launch ssh (which lands in the tmux pane command) carries no
 *     secret.
 *   - First connect uses `StrictHostKeyChecking=accept-new` (TOFU — accept
 *     unknown, reject a CHANGED key), never `no`.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile as readFileAsync, readdir as readdirAsync } from "node:fs/promises"
import { quoteShellArg, quoteShellArgv } from "../lib/shell-command"

/** SSH auth: a key (or the agent) vs a password held in the OS keychain. */
export type RemoteAuth =
  | { readonly kind: "key"; readonly keyPath?: string } // keyPath absent → ssh-agent / default identities
  | { readonly kind: "password"; readonly getPassword: () => string | null } // secret fetched lazily from keychain

/** Everything RemoteExecHost needs to reach a host (no persisted secret). */
export interface RemoteSpec {
  readonly host: string
  readonly user: string
  readonly port?: number
  readonly auth: RemoteAuth
  /** ControlMaster socket path (one per remote project, under KOBE_HOME). */
  readonly controlPath: string
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ExecOpts {
  /** Working directory the command runs in (a LOCAL path locally, a REMOTE path remotely). */
  readonly cwd?: string
  /** Extra environment for the command. Local merges it into process env; remote prefixes safe keys into the shell command. */
  readonly env?: Readonly<Record<string, string>>
  /** Optional cancellation signal. Local and remote async subprocesses receive it. */
  readonly signal?: AbortSignal
}

/**
 * The local/remote execution seam. `run` matches `orchestrator/worktree/git.ts`'s
 * result shape so the worktree manager routes through it unchanged; fs helpers
 * cover the direct `fs` reads the manager / slug allocator also do.
 *
 * ASYNC members (`run`, `exists`, `mkdirp`, `readFile`, `readdir`) are the
 * ones that do real subprocess / ssh / disk work — awaiting them keeps the
 * daemon's event loop free. SYNC members are metadata (`isRemote`), pure
 * string building (`wrapCommand`), and `ensureReady` (see file header).
 */
export interface ExecHost {
  readonly isRemote: boolean
  /** Run argv on the host. ASYNC — never blocks the caller's event loop. */
  run(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult>
  /** Whether `path` exists on the host. ASYNC (remote = ssh round-trip). */
  exists(path: string): Promise<boolean>
  /** `mkdir -p`. ASYNC (remote = ssh round-trip). */
  mkdirp(path: string): Promise<void>
  /** Read a file as utf8, or null when unreadable. ASYNC. */
  readFile(path: string): Promise<string | null>
  /** List directory entries (empty on failure). ASYNC. */
  readdir(path: string): Promise<string[]>
  /**
   * Wrap a command STRING so it runs on the host — used by the tmux engine
   * launch (the result lands in the pane command). Local → returned as-is;
   * remote → `ssh -tt … '<cd cwd && cmd>'` reusing the control socket (no
   * secret in the string). The caller must `ensureReady()` first for remote.
   * SYNC — pure string building.
   */
  wrapCommand(command: string, opts?: { readonly tty?: boolean; readonly cwd?: string }): string
  /**
   * Bring up the connection (no-op locally; opens the ControlMaster remotely).
   * SYNC — the one remaining sync-ssh site; called from TUI engine launch and
   * once per RemoteExecHost instance before the first async `run`.
   */
  ensureReady(): void
}

// ── pure shell / ssh construction (exported for tests) ───────────────────────

/** Single-quote a string for a POSIX shell — the shared {@link quoteShellArg}. */
export const shQuote = quoteShellArg

/** Quote each argv element and join — the shared {@link quoteShellArgv}. */
export const shJoin = quoteShellArgv

/** Single-quote a token only if it contains characters that aren't safe to
 *  leave bare in a POSIX shell word. Keeps flags / `user@host` readable while
 *  still protecting paths with spaces or metachars. */
export function shToken(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : quoteShellArg(s)
}

/** The remote command string: `cd <cwd> && <argv>` (or just `<argv>` with no cwd). */
export function remoteShellCommand(argv: readonly string[], cwd?: string): string {
  const cmd = shJoin(argv)
  return cwd ? `cd ${shQuote(cwd)} && ${cmd}` : cmd
}

function remoteEnvPrefix(env: Readonly<Record<string, string>> | undefined): string {
  if (!env) return ""
  const pairs = Object.entries(env).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
  if (pairs.length === 0) return ""
  return `${pairs.map(([key, value]) => `${key}=${shQuote(value)}`).join(" ")} `
}

/**
 * The `ssh` connection argv (program + flags + `user@host`), WITHOUT the
 * remote command and WITHOUT any sshpass prefix. `tty` adds `-tt` (force a
 * PTY for the interactive engine); `batch` adds `BatchMode=yes` so a
 * non-interactive call fails fast instead of prompting.
 */
export function sshConnectArgs(spec: RemoteSpec, opts: { tty?: boolean; batch?: boolean } = {}): string[] {
  const argv = ["ssh"]
  if (opts.tty) argv.push("-tt")
  if (opts.batch) argv.push("-o", "BatchMode=yes")
  // Reuse one multiplexed connection per remote project (the perf keystone).
  argv.push("-o", "ControlMaster=auto", "-o", `ControlPath=${spec.controlPath}`, "-o", "ControlPersist=300")
  // TOFU: accept an unknown host key on first connect, reject a CHANGED one.
  argv.push("-o", "StrictHostKeyChecking=accept-new")
  if (spec.port) argv.push("-p", String(spec.port))
  if (spec.auth.kind === "key" && spec.auth.keyPath) argv.push("-i", spec.auth.keyPath)
  argv.push(`${spec.user}@${spec.host}`)
  return argv
}

/**
 * Async spawn that collects stdout/stderr and resolves with the same result
 * contract `spawnSync` produced (`status ?? -1`, `stdout/stderr ?? ""`):
 *   - non-zero exit → resolved result with that exitCode (never rejects);
 *   - spawn failure (ENOENT, bad cwd, …) → `{ stdout: "", stderr: "", exitCode: -1 }`,
 *     matching the old `SpawnSyncReturns`-derived shape exactly.
 */
function spawnCollect(
  argv: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = argv
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      resolve({ stdout, stderr, exitCode })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd ?? "", rest, {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        signal: opts.signal,
      })
    } catch {
      finish(-1)
      return
    }
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (d: string) => {
      stdout += d
    })
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (d: string) => {
      stderr += d
    })
    // ENOENT and friends: spawnSync reported status null → -1; mirror that.
    child.on("error", () => finish(-1))
    child.on("close", (code) => finish(code ?? -1))
  })
}

// ── Local ────────────────────────────────────────────────────────────────────

/** Run things on the local machine — today's behavior, made non-blocking. */
export class LocalExecHost implements ExecHost {
  readonly isRemote = false

  run(argv: readonly string[], opts: ExecOpts = {}): Promise<ExecResult> {
    return spawnCollect(argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      signal: opts.signal,
    })
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path)
  }
  async mkdirp(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }
  async readFile(path: string): Promise<string | null> {
    try {
      return await readFileAsync(path, "utf8")
    } catch {
      return null
    }
  }
  async readdir(path: string): Promise<string[]> {
    try {
      return await readdirAsync(path)
    } catch {
      return []
    }
  }
  wrapCommand(command: string): string {
    return command
  }
  ensureReady(): void {}
}

// ── Remote ─────────────────────────────────────────────────────────────────

/**
 * Spawn seam so tests can assert the ssh argv without a real connection.
 * SYNC — used by `ensureReady` (ControlMaster bring-up).
 */
export type Spawner = (argv: readonly string[], env?: Record<string, string>) => ExecResult

/** ASYNC spawn seam — used by `run` (and everything built on it). */
export type AsyncSpawner = (
  argv: readonly string[],
  env?: Record<string, string>,
  opts?: { signal?: AbortSignal },
) => Promise<ExecResult>

const defaultSpawner: Spawner = (argv, env) => {
  const [cmd, ...rest] = argv
  const proc = spawnSync(cmd ?? "", rest, {
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    shell: false,
  })
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 }
}

const defaultAsyncSpawner: AsyncSpawner = (argv, env, opts) =>
  spawnCollect(argv, {
    env: env ? { ...process.env, ...env } : process.env,
    signal: opts?.signal,
  })

/**
 * Run things on a remote host over SSH. Every `run`/fs call becomes
 * `ssh … 'cd <cwd> && <cmd>'` over a multiplexed control socket; `ensureReady`
 * opens that socket once (with sshpass for the password path, which is read
 * from the keychain and used exactly once — never in a later command).
 *
 * `run` and the fs helpers are ASYNC (the per-call ssh spawn never blocks the
 * event loop). `ensureReady` stays sync — see the file header.
 */
export class RemoteExecHost implements ExecHost {
  readonly isRemote = true
  private masterUp = false
  private readonly spawnAsync: AsyncSpawner

  constructor(
    private readonly spec: RemoteSpec,
    private readonly spawn: Spawner = defaultSpawner,
    spawnAsync?: AsyncSpawner,
  ) {
    // A test that injects only a sync fake spawner gets it for async calls
    // too (wrapped), so argv-recording fakes keep observing every call.
    this.spawnAsync =
      spawnAsync ?? (this.spawn === defaultSpawner ? defaultAsyncSpawner : async (argv, env) => this.spawn(argv, env))
  }

  /** Open the ControlMaster master once. Idempotent: a live socket is reused. */
  ensureReady(): void {
    if (this.masterUp) return
    // `-O check` succeeds (exit 0) when the master socket is already alive.
    const check = this.spawn([...sshConnectArgs(this.spec, { batch: true }), "-O", "check"])
    if (check.exitCode === 0) {
      this.masterUp = true
      return
    }
    // Bring up a backgrounded master (-fN). Password auth feeds sshpass via
    // SSHPASS env (NEVER -p, which leaks on argv); key/agent needs no prefix.
    const base = [...sshConnectArgs(this.spec, { batch: this.spec.auth.kind !== "password" }), "-fN"]
    if (this.spec.auth.kind === "password") {
      const pw = this.spec.auth.getPassword()
      if (pw != null) {
        this.spawn(["sshpass", "-e", ...base], { SSHPASS: pw })
        this.masterUp = true
        return
      }
    }
    this.spawn(base)
    this.masterUp = true
  }

  async run(argv: readonly string[], opts: ExecOpts = {}): Promise<ExecResult> {
    // Sync ControlMaster bring-up on the FIRST call per host instance (see
    // file header — the remaining sync-ssh site); later calls are a no-op.
    this.ensureReady()
    // No sshpass here — the multiplexed master carries the channel with no
    // re-auth, so no secret ever reaches a per-call command.
    const command = `${remoteEnvPrefix(opts.env)}${shJoin(argv)}`
    const remote = opts.cwd ? `cd ${shQuote(opts.cwd)} && ${command}` : command
    return this.spawnAsync([...sshConnectArgs(this.spec, { batch: true }), remote], undefined, { signal: opts.signal })
  }

  async exists(path: string): Promise<boolean> {
    return (await this.run(["test", "-e", path])).exitCode === 0
  }
  async mkdirp(path: string): Promise<void> {
    await this.run(["mkdir", "-p", path])
  }
  async readFile(path: string): Promise<string | null> {
    const r = await this.run(["cat", path])
    return r.exitCode === 0 ? r.stdout : null
  }
  async readdir(path: string): Promise<string[]> {
    const r = await this.run(["ls", "-1A", path])
    if (r.exitCode !== 0) return []
    return r.stdout.split("\n").filter((s) => s.length > 0)
  }

  wrapCommand(command: string, opts: { tty?: boolean; cwd?: string } = {}): string {
    // A string for the LOCAL shell tmux runs the pane in: ssh (reusing the
    // master) + the remote command, single-quoted so the local shell hands it
    // to ssh as one arg and the REMOTE shell parses it. No sshpass → no secret.
    const remote = opts.cwd ? `cd ${shQuote(opts.cwd)} && ${command}` : command
    // Quote each connection arg that needs it before joining: this string is
    // parsed by the local shell (tmux's pane launch), and the argv carries
    // paths (ControlPath, `-i` keyPath) and `user@host` that can contain spaces
    // or metachars. Shell-safe tokens (ssh, -tt, user@host) stay bare for
    // readability; anything else is single-quoted. Every other caller hands the
    // argv straight to spawn (no shell), so only this string-join path needs it.
    const connect = sshConnectArgs(this.spec, { tty: opts.tty }).map(shToken).join(" ")
    return `${connect} ${shQuote(remote)}`
  }
}
