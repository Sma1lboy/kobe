import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile as readFileAsync, readdir as readdirAsync } from "node:fs/promises"
import { quoteShellArg, quoteShellArgv } from "../lib/shell-command"

export type RemoteAuth =
  | { readonly kind: "key"; readonly keyPath?: string }
  | { readonly kind: "password"; readonly getPassword: () => string | null }

export interface RemoteSpec {
  readonly host: string
  readonly user: string
  readonly port?: number
  readonly auth: RemoteAuth
  readonly controlPath: string
}

export interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface ExecOpts {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export interface ExecHost {
  readonly isRemote: boolean
  run(argv: readonly string[], opts?: ExecOpts): Promise<ExecResult>
  exists(path: string): Promise<boolean>
  mkdirp(path: string): Promise<void>
  readFile(path: string): Promise<string | null>
  readdir(path: string): Promise<string[]>
  wrapCommand(command: string, opts?: { readonly tty?: boolean; readonly cwd?: string }): string
  ensureReady(): void
}

export const shQuote = quoteShellArg

export const shJoin = quoteShellArgv

export function shToken(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : quoteShellArg(s)
}

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

export function sshConnectArgs(spec: RemoteSpec, opts: { tty?: boolean; batch?: boolean } = {}): string[] {
  const argv = ["ssh"]
  if (opts.tty) argv.push("-tt")
  if (opts.batch) argv.push("-o", "BatchMode=yes")
  argv.push("-o", "ControlMaster=auto", "-o", `ControlPath=${spec.controlPath}`, "-o", "ControlPersist=300")
  argv.push("-o", "StrictHostKeyChecking=accept-new")
  if (spec.port) argv.push("-p", String(spec.port))
  if (spec.auth.kind === "key" && spec.auth.keyPath) argv.push("-i", spec.auth.keyPath)
  argv.push(`${spec.user}@${spec.host}`)
  return argv
}

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
    child.on("error", () => finish(-1))
    child.on("close", (code) => finish(code ?? -1))
  })
}

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

export type Spawner = (argv: readonly string[], env?: Record<string, string>) => ExecResult

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

export class RemoteExecHost implements ExecHost {
  readonly isRemote = true
  private masterUp = false
  private readonly spawnAsync: AsyncSpawner

  constructor(
    private readonly spec: RemoteSpec,
    private readonly spawn: Spawner = defaultSpawner,
    spawnAsync?: AsyncSpawner,
  ) {
    this.spawnAsync =
      spawnAsync ?? (this.spawn === defaultSpawner ? defaultAsyncSpawner : async (argv, env) => this.spawn(argv, env))
  }

  ensureReady(): void {
    if (this.masterUp) return
    const check = this.spawn([...sshConnectArgs(this.spec, { batch: true }), "-O", "check"])
    if (check.exitCode === 0) {
      this.masterUp = true
      return
    }
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
    this.ensureReady()
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
    const remote = opts.cwd ? `cd ${shQuote(opts.cwd)} && ${command}` : command
    const connect = sshConnectArgs(this.spec, { tty: opts.tty }).map(shToken).join(" ")
    return `${connect} ${shQuote(remote)}`
  }
}
