/**
 * Behavior-suite harness for the built CLI. Every run gets a disposable
 * HOME/XDG tree, PATH-first kobe and engine shims, and isolated daemon/PTY
 * host paths derived from that home.
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
export const DIST_CLI = join(PKG_ROOT, "dist/cli/kobe.js")
export const DIST_ROVE_CLI = join(PKG_ROOT, "dist/cli/rove.js")

export interface BehaviorEnv {
  readonly home: string
  readonly bin: string
  readonly env: NodeJS.ProcessEnv
  dispose(): Promise<void>
}

export function requireDistBuild(): void {
  if (!existsSync(DIST_CLI) || !existsSync(DIST_ROVE_CLI)) {
    throw new Error("behavior suite needs the built kobe and rove entries under dist/cli — run `bun run build` first")
  }
}

function teardownIsolationError(env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (env.HOME !== home || env.USERPROFILE !== home || env.KOBE_HOME_DIR !== home) {
    return "HOME/KOBE_HOME_DIR no longer match the disposable home"
  }
  const unexpected = Object.keys(env).filter(
    (key) => (key.startsWith("KOBE_") && key !== "KOBE_HOME_DIR") || key.startsWith("ROVE_"),
  )
  if (unexpected.length > 0) return `unexpected controls: ${unexpected.sort().join(", ")}`
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

  await writeFile(join(bin, "kobe"), `#!/bin/sh\nexec bun ${DIST_CLI} "$@"\n`)
  await chmod(join(bin, "kobe"), 0o755)
  await writeFile(join(bin, "rove"), `#!/bin/sh\nexec bun ${DIST_ROVE_CLI} "$@"\n`)
  await chmod(join(bin, "rove"), 0o755)
  // The idle loop must keep the shim's OWN name in `ps`. `exec sleep 600`
  // replaced the process image, so the tab's tree read as `sleep` with no
  // `claude` anywhere — and the delivery foreground gate (engineProcessIn)
  // correctly called that "engine exited into a shell". A real engine never
  // renames itself; `read` blocks in-process, so argv[0] stays `claude`.
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh\necho "fake-claude ready $*"\nwhile :; do read -r _ignored || sleep 600; done\n`,
  )
  await chmod(join(bin, "claude"), 0o755)

  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("KOBE_") &&
        !key.startsWith("ROVE_") &&
        key !== "HOME" &&
        key !== "USERPROFILE" &&
        !key.startsWith("XDG_") &&
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
  }

  return {
    home,
    bin,
    env,
    async dispose() {
      try {
        const isolationError = teardownIsolationError(env, home)
        if (isolationError) throw new Error(`behavior harness refusing destructive teardown: ${isolationError}`)
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

export function runKobe(args: readonly string[], env: BehaviorEnv, opts?: { input?: string }): CliResult {
  const result = spawnSync("bun", [DIST_CLI, ...args], {
    env: env.env,
    input: opts?.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  })
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

export function runRove(args: readonly string[], env: BehaviorEnv, opts?: { input?: string }): CliResult {
  const result = spawnSync("bun", [DIST_ROVE_CLI, ...args], {
    env: env.env,
    input: opts?.input ?? "",
    encoding: "utf8",
    timeout: 60_000,
  })
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
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

/**
 * The PTY-driving suites' shared gate: `node-pty` loaded AND able to spawn
 * here.
 *
 * Presence alone is not capability. A sandboxed runner can have the module
 * installed while every `posix_spawnp` is denied — the suite then failed with
 * an environment error that looks exactly like a product regression, and
 * (since `release.sh` runs the behavior suite) blocked releases on a machine
 * where the test can never run. CI has a real PTY, so coverage there is
 * unchanged; a machine that cannot spawn skips instead of failing.
 *
 * The probe spawns `/bin/sh -c :` once per process and caches the verdict.
 */
export async function loadNodePty(): Promise<typeof import("node-pty") | null> {
  const mod = await import("node-pty").then(
    (m) => m,
    () => null,
  )
  if (!mod) return null
  try {
    const probe = mod.spawn("/bin/sh", ["-c", ":"], { cols: 80, rows: 24, env: process.env as Record<string, string> })
    probe.kill()
    return mod
  } catch {
    console.warn("[behavior] node-pty cannot spawn in this environment — skipping the PTY-driven suites")
    return null
  }
}
