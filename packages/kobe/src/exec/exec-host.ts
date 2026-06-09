/**
 * ExecHost — the local/remote execution seam for remote projects.
 *
 * Everything kobe runs on the "worktree side" (git, fs reads, the engine
 * launch) goes through an ExecHost so a REMOTE project runs the exact same
 * logic over SSH while a LOCAL project keeps today's behavior verbatim:
 *
 *   - LocalExecHost  — `spawnSync` + node `fs` (the default; zero regression).
 *   - RemoteExecHost — wraps every command in `ssh … 'cd <cwd> && <cmd>'`,
 *     reusing ONE multiplexed connection per remote project (ControlMaster).
 *
 * A task resolves its ExecHost once from its project's remote config (see
 * `state/repos.ts` remoteRepos). See `docs/design/remote-projects.md`.
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

import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"

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
  /** Extra environment merged onto the inherited env (local only; remote ignores it for now). */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * The local/remote execution seam. `run` matches `orchestrator/worktree/git.ts`'s
 * shape so the worktree manager routes through it unchanged; fs helpers cover
 * the direct `fs` reads the manager / ops pane / history readers also do.
 */
export interface ExecHost {
  readonly isRemote: boolean
  run(argv: readonly string[], opts?: ExecOpts): ExecResult
  runAsync(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult>
  exists(path: string): boolean
  mkdirp(path: string): void
  readFile(path: string): string | null
  readdir(path: string): string[]
  /**
   * Wrap a command STRING so it runs on the host — used by the tmux engine
   * launch (the result lands in the pane command). Local → returned as-is;
   * remote → `ssh -tt … '<cd cwd && cmd>'` reusing the control socket (no
   * secret in the string). The caller must `ensureReady()` first for remote.
   */
  wrapCommand(command: string, opts?: { readonly tty?: boolean; readonly cwd?: string }): string
  /** Bring up the connection (no-op locally; opens the ControlMaster remotely). */
  ensureReady(): void
}

// ── pure shell / ssh construction (exported for tests) ───────────────────────

/** Single-quote a string for a POSIX shell (`'` → `'\''`). */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/** Quote each argv element and join — a safe command line for a POSIX shell. */
export function shJoin(argv: readonly string[]): string {
  return argv.map(shQuote).join(" ")
}

/** The remote command string: `cd <cwd> && <argv>` (or just `<argv>` with no cwd). */
export function remoteShellCommand(argv: readonly string[], cwd?: string): string {
  const cmd = shJoin(argv)
  return cwd ? `cd ${shQuote(cwd)} && ${cmd}` : cmd
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

// ── Local ────────────────────────────────────────────────────────────────────

/** Run things on the local machine — today's behavior, verbatim. */
export class LocalExecHost implements ExecHost {
  readonly isRemote = false

  run(argv: readonly string[], opts: ExecOpts = {}): ExecResult {
    const [cmd, ...rest] = argv
    const proc = spawnSync(cmd ?? "", rest, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      encoding: "utf8",
      shell: false,
    })
    return toResult(proc)
  }

  async runAsync(argv: readonly string[], opts: ExecOpts = {}): Promise<ExecResult> {
    return this.run(argv, opts)
  }

  exists(path: string): boolean {
    return existsSync(path)
  }
  mkdirp(path: string): void {
    mkdirSync(path, { recursive: true })
  }
  readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  }
  readdir(path: string): string[] {
    try {
      return readdirSync(path)
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

/** Spawn seam so tests can assert the ssh argv without a real connection. */
export type Spawner = (argv: readonly string[], env?: Record<string, string>) => ExecResult

const defaultSpawner: Spawner = (argv, env) => {
  const [cmd, ...rest] = argv
  return toResult(
    spawnSync(cmd ?? "", rest, {
      env: env ? { ...process.env, ...env } : process.env,
      encoding: "utf8",
      shell: false,
    }),
  )
}

/**
 * Run things on a remote host over SSH. Every `run`/fs call becomes
 * `ssh … 'cd <cwd> && <cmd>'` over a multiplexed control socket; `ensureReady`
 * opens that socket once (with sshpass for the password path, which is read
 * from the keychain and used exactly once — never in a later command).
 */
export class RemoteExecHost implements ExecHost {
  readonly isRemote = true
  private masterUp = false

  constructor(
    private readonly spec: RemoteSpec,
    private readonly spawn: Spawner = defaultSpawner,
  ) {}

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

  run(argv: readonly string[], opts: ExecOpts = {}): ExecResult {
    this.ensureReady()
    // No sshpass here — the multiplexed master carries the channel with no
    // re-auth, so no secret ever reaches a per-call command.
    return this.spawn([...sshConnectArgs(this.spec, { batch: true }), remoteShellCommand(argv, opts.cwd)])
  }

  async runAsync(argv: readonly string[], opts: ExecOpts = {}): Promise<ExecResult> {
    return this.run(argv, opts)
  }

  exists(path: string): boolean {
    return this.run(["test", "-e", path]).exitCode === 0
  }
  mkdirp(path: string): void {
    this.run(["mkdir", "-p", path])
  }
  readFile(path: string): string | null {
    const r = this.run(["cat", path])
    return r.exitCode === 0 ? r.stdout : null
  }
  readdir(path: string): string[] {
    const r = this.run(["ls", "-1A", path])
    if (r.exitCode !== 0) return []
    return r.stdout.split("\n").filter((s) => s.length > 0)
  }

  wrapCommand(command: string, opts: { tty?: boolean; cwd?: string } = {}): string {
    // A string for the LOCAL shell tmux runs the pane in: ssh (reusing the
    // master) + the remote command, single-quoted so the local shell hands it
    // to ssh as one arg and the REMOTE shell parses it. No sshpass → no secret.
    const remote = opts.cwd ? `cd ${shQuote(opts.cwd)} && ${command}` : command
    return `${sshConnectArgs(this.spec, { tty: opts.tty }).join(" ")} ${shQuote(remote)}`
  }
}

function toResult(proc: SpawnSyncReturns<string>): ExecResult {
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? -1 }
}
