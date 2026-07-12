/**
 * Behavior-suite harness: run the BUILT kobe CLI (`dist/cli/index.js`) as a
 * black box in a disposable environment — temp `KOBE_HOME`, its own tmux
 * socket, and a PATH-first `kobe` shim so persisted commands/spawns resolve
 * to the same build under test. The driving pattern (isolated socket +
 * throwaway home + shim + send-keys/capture-pane + kill-panes-then-server)
 * is lifted from packages/branding/scripts/capture-tui.ts, which records the
 * real product for demo videos — the behavior tests operate kobe the same way
 * a recording session does.
 *
 * Runs the DIST build on purpose: packaged-only code paths (e.g.
 * `import.meta.url.endsWith(".js")` branches) are exactly where dev-only unit
 * runs went blind. `bun run build` must have run first; the harness throws a
 * clear error otherwise.
 */

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import {
  defaultDaemonPidPath,
  defaultDaemonSocketPath,
  defaultPtyHostPidPath,
  defaultPtyHostSocketPath,
} from "@sma1lboy/kobe-daemon/daemon/paths"

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const DIST_CLI = join(PKG_ROOT, "dist/cli/index.js")

export interface BehaviorEnv {
  /** Throwaway KOBE_HOME (also holds the bin shims). */
  home: string
  /** Directory prepended to PATH; contains the `kobe` + fake `claude` shims. */
  bin: string
  /** kobe's OWN tmux socket (KOBE_TMUX_SOCKET — task sessions live here). */
  socket: string
  /** Host socket the tests attach/drive kobe FROM (send-keys/capture-pane). */
  outerSocket: string
  /** Full env for every spawn in this environment. */
  env: NodeJS.ProcessEnv
  /** Tear everything down: tmux panes+server, daemon, temp dir. */
  dispose(): Promise<void>
}

export function requireDistBuild(): void {
  if (!existsSync(DIST_CLI)) {
    throw new Error(`behavior suite needs the built CLI at ${DIST_CLI} — run \`bun run build\` first`)
  }
}

let envSeq = 0

function behaviorTeardownIsolationError(env: NodeJS.ProcessEnv, home: string, socket: string): string | undefined {
  if (env.HOME !== home || env.USERPROFILE !== home || env.KOBE_HOME_DIR !== home) {
    return "HOME/KOBE_HOME_DIR no longer match the disposable home"
  }
  if (env.KOBE_TMUX_SOCKET !== socket) return "KOBE_TMUX_SOCKET no longer matches the disposable socket"
  const unexpectedKobeKeys = Object.keys(env).filter(
    (key) => key.startsWith("KOBE_") && key !== "KOBE_HOME_DIR" && key !== "KOBE_TMUX_SOCKET",
  )
  if (unexpectedKobeKeys.length > 0) return `unexpected controls: ${unexpectedKobeKeys.sort().join(", ")}`
  return undefined
}

export async function makeBehaviorEnv(): Promise<BehaviorEnv> {
  requireDistBuild()
  const home = await mkdtemp(join(tmpdir(), "kobe-behavior-"))
  const bin = join(home, "bin")
  const xdgConfig = join(home, ".config")
  const xdgData = join(home, ".local", "share")
  const xdgState = join(home, ".local", "state")
  const xdgCache = join(home, ".cache")
  const xdgRuntime = join(home, ".runtime")
  await Promise.all(
    [bin, xdgConfig, xdgData, xdgState, xdgCache, xdgRuntime].map((dir) => mkdir(dir, { recursive: true })),
  )
  const socket = `kobe-behavior-${process.pid}-${envSeq++}`
  const outerSocket = `${socket}-outer`

  // PATH-first shim named `kobe` running the dist build (same trick as the
  // video capture: the on-screen/persisted command is `kobe`, the code is ours).
  await writeFile(join(bin, "kobe"), `#!/bin/sh\nexec bun ${DIST_CLI} "$@"\n`)
  await chmod(join(bin, "kobe"), 0o755)
  // Fake engine so a task/engine pane renders without a real `claude` on CI.
  // Ignores SIGHUP like the real CLI does (`trap` sets SIG_IGN, which `exec`
  // preserves) — pane-cleanup.test.ts depends on this to reproduce the
  // "engine CLI swallows HUP" half of the #205/bc69596 leak.
  await writeFile(join(bin, "claude"), `#!/bin/sh\ntrap '' HUP\necho "fake-claude ready"\nexec sleep 600\n`)
  await chmod(join(bin, "claude"), 0o755)

  // A behavior run is frequently launched FROM the live kobe process, whose
  // environment deliberately points at production sockets. Never pass any
  // ambient KOBE_* control through to a
  // black-box child: teardown stops daemon processes, so one inherited
  // socket/pid override could stop the user's real daemon or PTY host. HOME and
  // XDG are isolated too because normal TUI boot installs engine hooks under
  // ~/.claude and ~/.codex independently of KOBE_HOME_DIR.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("KOBE_") &&
        key !== "HOME" &&
        key !== "USERPROFILE" &&
        !key.startsWith("XDG_") &&
        key !== "TMUX" &&
        key !== "TMUX_PANE" &&
        key !== "TERM" &&
        key !== "TERM_PROGRAM" &&
        key !== "TERM_PROGRAM_VERSION" &&
        key !== "COLORTERM",
    ),
  )
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    XDG_CACHE_HOME: xdgCache,
    XDG_RUNTIME_DIR: xdgRuntime,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    PATH: `${bin}:${inherited.PATH ?? ""}`,
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
      // Panes first, then server, on BOTH sockets: kill-server only SIGHUPs
      // panes and the opentui pane hosts survive SIGHUP (capture-tui.ts
      // learned this the hard way — orphaned `kobe tasks/ops` processes
      // reparented to init).
      killPanesThenServer(outerSocket, env)
      killPanesThenServer(socket, env)
      try {
        const isolationError = behaviorTeardownIsolationError(env, home, socket)
        if (isolationError) {
          throw new Error(`behavior harness refusing destructive teardown: ${isolationError}`)
        }
        await stopDaemonProcess(defaultDaemonSocketPath(home), defaultDaemonPidPath(home))
        await stopDaemonProcess(defaultPtyHostSocketPath(home), defaultPtyHostPidPath(home))
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    },
  }
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Run `kobe <args>` (dist build) piped — the black-box unit of this suite. */
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

/** Drive the OUTER (host) socket — where the test attaches/keys/captures. */
export function tmux(env: BehaviorEnv, ...args: string[]): CliResult {
  return tmuxOn(env, env.outerSocket, ...args)
}

/** Query kobe's INNER socket — where the task sessions/panes actually live. */
export function tmuxInner(env: BehaviorEnv, ...args: string[]): CliResult {
  return tmuxOn(env, env.socket, ...args)
}

function tmuxOn(env: BehaviorEnv, socket: string, ...args: string[]): CliResult {
  const r = spawnSync("tmux", ["-L", socket, ...args], { env: env.env, encoding: "utf8", timeout: 30_000 })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** Poll `capture-pane` until `predicate` matches or `timeoutMs` elapses. */
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
      } catch {
        /* already gone */
      }
    }
  }
  spawnSync("tmux", ["-L", socket, "kill-server"], { env: env as NodeJS.ProcessEnv })
}

/** A scratch git repo (init + one commit) for flows that need a project dir. */
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
