/**
 * Client-side lifecycle for the standalone PTY HOST process
 * (`kobe pty-host`, see `daemon/pty-server.ts`) — the tmux-server analog
 * that keeps embedded-terminal children alive across TUI exits AND
 * `kobe daemon restart`. Mirrors `daemon-process.ts`'s spawn-and-poll
 * shape against the pty host's own socket.
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
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
export async function resolveNodePtyHostSpawn(): Promise<string[] | null> {
  if (process.platform !== "win32") return null
  const here = dirname(fileURLToPath(import.meta.url))

  const packaged = resolve(here, PTY_HOST_NODE_BUNDLE)
  if (existsSync(packaged)) return ["node", packaged]

  const entry = resolve(here, PTY_HOST_NODE_ENTRY)
  if (!existsSync(entry)) {
    throw new Error(`kobe: no Windows PTY host found (looked for ${packaged} and ${entry})`)
  }
  const cache = resolve(here, PTY_HOST_NODE_DEV_CACHE)
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: dirname(cache),
    target: "node",
    format: "esm",
    naming: PTY_HOST_NODE_BUNDLE,
    external: ["node-pty"],
  })
  if (!built.success) {
    throw new Error(`kobe: could not build the Windows PTY host — ${built.logs.map(String).join("; ")}`)
  }
  return ["node", cache]
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
