import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const DIST_CLI = join(PKG_ROOT, "dist/cli/index.js")

export interface BehaviorEnv {
  home: string
  bin: string
  socket: string
  outerSocket: string
  env: NodeJS.ProcessEnv
  dispose(): Promise<void>
}

export function requireDistBuild(): void {
  if (!existsSync(DIST_CLI)) {
    throw new Error(`behavior suite needs the built CLI at ${DIST_CLI} — run \`bun run build\` first`)
  }
}

let envSeq = 0

export async function makeBehaviorEnv(): Promise<BehaviorEnv> {
  requireDistBuild()
  const home = await mkdtemp(join(tmpdir(), "kobe-behavior-"))
  const bin = join(home, "bin")
  await mkdir(bin, { recursive: true })
  const socket = `kobe-behavior-${process.pid}-${envSeq++}`
  const outerSocket = `${socket}-outer`

  await writeFile(join(bin, "kobe"), `#!/bin/sh\nexec bun ${DIST_CLI} "$@"\n`)
  await chmod(join(bin, "kobe"), 0o755)
  await writeFile(join(bin, "claude"), `#!/bin/sh\ntrap '' HUP\necho "fake-claude ready"\nexec sleep 600\n`)
  await chmod(join(bin, "claude"), 0o755)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    KOBE_HOME_DIR: home,
    KOBE_TMUX_SOCKET: socket,
  }

  return {
    home,
    bin,
    socket,
    outerSocket,
    env,
    async dispose() {
      killPanesThenServer(outerSocket, env)
      killPanesThenServer(socket, env)
      spawnSync("bun", [DIST_CLI, "reset", "--yes"], { env, timeout: 30_000 })
      await rm(home, { recursive: true, force: true })
    },
  }
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export function runKobe(args: readonly string[], env: BehaviorEnv, opts?: { input?: string }): CliResult {
  const r = spawnSync("bun", [DIST_CLI, ...args], {
    env: env.env,
    input: opts?.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export function tmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0
}

export function tmux(env: BehaviorEnv, ...args: string[]): CliResult {
  return tmuxOn(env, env.outerSocket, ...args)
}

export function tmuxInner(env: BehaviorEnv, ...args: string[]): CliResult {
  return tmuxOn(env, env.socket, ...args)
}

function tmuxOn(env: BehaviorEnv, socket: string, ...args: string[]): CliResult {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env: env.env, encoding: "utf8", timeout: 30_000 })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

export async function waitForScreen(
  env: BehaviorEnv,
  target: string,
  predicate: (screen: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    last = tmux(env, "capture-pane", "-t", target, "-p").stdout
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`waitForScreen: predicate never matched.\n--- last screen ---\n${last}`)
}

function killPanesThenServer(socket: string, env: NodeJS.ProcessEnv | BehaviorEnv["env"]): void {
  const out = spawnSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_pid}"], {
    env: env as NodeJS.ProcessEnv,
    encoding: "utf8",
  })
  for (const line of (out.stdout ?? "").split("\n")) {
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 1) continue
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
  spawnSync("tmux", ["-L", socket, "kill-server"], { env: env as NodeJS.ProcessEnv })
}

export async function makeScratchRepo(env: BehaviorEnv): Promise<string> {
  const repo = join(env.home, "scratch-repo")
  await mkdir(repo, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: env.env })
  git("init", "-q")
  git("config", "user.email", "behavior@test.local")
  git("config", "user.name", "behavior")
  await writeFile(join(repo, "README.md"), "scratch\n")
  git("add", "README.md")
  git("commit", "-q", "-m", "init")
  return repo
}
