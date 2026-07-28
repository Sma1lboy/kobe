/**
 * Client-side lifecycle for the standalone PTY HOST process
 * (`kobe pty-host`, see `daemon/pty-server.ts`) — the tmux-server analog
 * that keeps embedded-terminal children alive across TUI exits AND
 * `kobe daemon restart`. Mirrors `daemon-process.ts`'s spawn-and-poll
 * shape against the pty host's own socket.
 */

import { existsSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stopDaemonProcess } from "../daemon/lifecycle.ts"
import { defaultPtyHostLogPath, defaultPtyHostPidPath, defaultPtyHostSocketPath } from "../daemon/paths.ts"
import { resolveKobeSpawn, spawnDetachedDaemon, testDaemonResponds } from "./daemon-process.ts"
import { KobeDaemonClient } from "./index.ts"

const PTY_HOST_START_ARGS = ["pty-host"] as const

/** Where `bun run build` puts the node PTY host, relative to the cli bundle. */
const PTY_HOST_NODE_BUNDLE = "pty-host-node.mjs"
/** Dev-only build cache. Must sit INSIDE the daemon package so the bundle's
 *  external `node-pty` import resolves against its node_modules. */
const PTY_HOST_NODE_DEV_CACHE = "../../.cache/pty-host-node.mjs"
const PTY_HOST_NODE_ENTRY = "../daemon/pty-host-node-entry.ts"

export interface NodePtyHostResolution {
  /** Real platform by default; injected so the Windows path is testable on CI. */
  readonly platform?: NodeJS.Platform
  /** Directory this module resolves its siblings against. */
  readonly moduleDir?: string
  readonly exists?: (path: string) => boolean
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Lands a node bundle of `entry` at `outFile`. Injected to keep the unit
   *  test off the bundler; landing it atomically is the impl's business. */
  readonly bundle?: (entry: string, outFile: string) => Promise<{ success: boolean; logs: readonly unknown[] }>
}

/**
 * Locate `node` on PATH, returning its absolute path.
 *
 * The Windows PTY host is a node program, but kobe itself runs under Bun — and
 * `bun install -g @sma1lboy/kobe` never brings node along. Without this the
 * spawn fails silently into the host's log and `ensurePtyHostReachable` only
 * reports a 5s timeout, which says nothing about the actual cause. Resolving
 * to an absolute path also stops the detached child from depending on however
 * PATH looks by the time it starts.
 */
export function resolveNodeBinary(
  env: Readonly<Record<string, string | undefined>> = process.env,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((dir) => dir.length > 0)
  // PATHEXT is what makes a bare `node` runnable on Windows; node.exe is the
  // real one, but a Volta/fnm shim may only put node.cmd on PATH.
  const suffixes =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((ext) => ext.length > 0) : [""]
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `node${suffix}`)
      if (exists(candidate)) return candidate
    }
  }
  return null
}

export interface BundleIo {
  build: (config: {
    entrypoints: string[]
    outdir: string
    target: string
    format: string
    naming: string
    external: string[]
  }) => Promise<{ success: boolean; logs: readonly unknown[] }>
  rename: (from: string, to: string) => Promise<void>
  discard: (path: string) => Promise<void>
}

/** Injected so the staging→rename dance is assertable without a bundler. */
export async function bundleWithBun(entry: string, outFile: string, io?: BundleIo) {
  const {
    build,
    rename: move,
    discard,
  } = io ?? {
    // Lazy: `Bun` is not a global under the test runner, and this default is
    // never evaluated when `io` is supplied.
    build: (config: Parameters<BundleIo["build"]>[0]) => Bun.build(config as Parameters<typeof Bun.build>[0]),
    rename,
    discard: (path: string) => rm(path, { force: true }),
  }
  // Build to a pid-unique sibling, then rename into place. Two kobe instances
  // can reach this together — both find no host, both rebuild the same
  // absolute path — and node must never load a half-written module. rename is
  // atomic on one volume, and node's Windows rename replaces the destination
  // rather than failing on it.
  const staging = `${outFile}.${process.pid}.tmp`
  const built = await build({
    entrypoints: [entry],
    outdir: dirname(staging),
    target: "node",
    format: "esm",
    naming: basename(staging),
    external: ["node-pty"],
  })
  if (!built.success) {
    // Leaving the partial behind would have the next run rename garbage into
    // the path the host is spawned from.
    await discard(staging).catch(() => {})
    return built
  }
  await move(staging, outFile)
  return built
}

/**
 * Windows runs the PTY host under NODE, not Bun: Bun rejects its `terminal`
 * spawn option there, and a Bun-hosted node-pty session can be read but never
 * written to. Returns `[node, script]`, or null when this isn't Windows (every
 * other platform keeps the ordinary `kobe pty-host` Bun path).
 *
 * Two layouts, mirroring {@link resolveKobeSpawn}:
 *  - installed package: `dist/cli/pty-host-node.mjs`, emitted by scripts/build.ts
 *    next to the cli bundle.
 *  - dev from source: no dist, so bundle the entry on demand into the daemon
 *    package's `.cache/` (gitignored) and run that.
 */
export async function resolveNodePtyHostSpawn(deps: NodePtyHostResolution = {}): Promise<string[] | null> {
  const platform = deps.platform ?? process.platform
  if (platform !== "win32") return null
  const here = deps.moduleDir ?? dirname(fileURLToPath(import.meta.url))
  const exists = deps.exists ?? existsSync
  const bundle = deps.bundle ?? bundleWithBun

  const node = resolveNodeBinary(deps.env ?? process.env, exists, platform)
  if (!node) {
    throw new Error(
      "kobe: the Windows PTY host runs under node, but no node was found on PATH. " +
        "Install Node.js (https://nodejs.org) and restart kobe — engine and terminal sessions cannot start without it.",
    )
  }

  const packaged = resolve(here, PTY_HOST_NODE_BUNDLE)
  if (exists(packaged)) return [node, packaged]

  const entry = resolve(here, PTY_HOST_NODE_ENTRY)
  if (!exists(entry)) {
    throw new Error(`kobe: no Windows PTY host found (looked for ${packaged} and ${entry})`)
  }
  const cache = resolve(here, PTY_HOST_NODE_DEV_CACHE)
  const built = await bundle(entry, cache)
  if (!built.success) {
    throw new Error(`kobe: could not build the Windows PTY host — ${built.logs.map(String).join("; ")}`)
  }
  return [node, cache]
}

/**
 * If the pty host socket already answers `hello`, do nothing. Otherwise
 * clear any wedged process and spawn a detached `kobe pty-host`, polling
 * until reachable. Returns the socket path. The terminal pane is the
 * product — it may resurrect an idle-exited host.
 */
export async function ensurePtyHostReachable(): Promise<string> {
  const socketPath = defaultPtyHostSocketPath()
  if (await testDaemonResponds(socketPath)) return socketPath

  await stopDaemonProcess(socketPath, defaultPtyHostPidPath()).catch(() => {})

  const [command, ...args] = (await resolveNodePtyHostSpawn()) ?? resolveKobeSpawn(PTY_HOST_START_ARGS)
  spawnDetachedDaemon(command ?? "", args, process.env, defaultPtyHostLogPath())

  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await testDaemonResponds(socketPath)) return socketPath
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100))
  }
  throw new Error(`kobe: pty host did not start (or stayed wedged) at ${socketPath}`)
}

/**
 * Fire-and-forget janitor call from the daemon: kill hosted sessions
 * whose task is archived/gone. NEVER spawns a host (nothing to sweep if
 * none is running) and never throws — the task snapshot path must not
 * fail on pty-host hiccups.
 *
 * `homeDir` MUST be the calling daemon's own home. A daemon that resolves
 * the ambient default while running against a non-default home (the
 * test:socket suite's temp-home daemons) sweeps the REAL user pty-host
 * with ITS task list — a fake orchestrator's empty snapshot then kills
 * every live engine session on the machine (incident 2026-07-07/08: every
 * `bun run test` wiped the user's running claude tabs).
 */
export async function sweepPtyHostSessions(liveTaskIds: readonly string[], homeDir?: string): Promise<void> {
  const socketPath = defaultPtyHostSocketPath(homeDir)
  const client = new KobeDaemonClient(socketPath)
  try {
    await client.connect()
    await client.request("pty.sweep", { liveTaskIds })
  } catch {
    /* no host running (or mid-exit) — nothing to sweep */
  } finally {
    client.close()
  }
}
