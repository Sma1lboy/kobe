/**
 * Bootstrap the orchestrator bridge: bind a Unix-socket RPC server
 * for the running orchestrator, write an MCP config that points
 * spawned `claude` processes at `kobe mcp-bridge`, and export
 * `KOBE_MCP_CONFIG` so the engine's `buildArgs` automatically
 * appends `--mcp-config <path>` to every spawn.
 *
 * Layout under `${homeDir}/.kobe/run/`:
 *   bridge-<pid>.sock      Unix socket the bridge subprocess connects to
 *   mcp-<pid>.json         claude's MCP config JSON
 *
 * Files are pid-scoped so two concurrent kobe processes don't trample
 * each other. The first call wins the env var; nested kobe instances
 * (a kobe-spawned task that itself runs kobe) inherit the parent's
 * bridge — sub-spawn agents see the same tool surface, which is the
 * desired behavior for now (no recursion guard yet).
 */

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { fitSocketPath } from "../../daemon/paths.ts"
import type { Orchestrator } from "../core.ts"
import { type BridgeServer, startBridgeServer } from "./server.ts"

export interface StartBridgeOpts {
  readonly homeDir?: string
}

export interface BridgeHandles {
  readonly socketPath: string
  readonly mcpConfigPath: string
  close(): Promise<void>
}

export function bridgeSocketPathForHome(home: string, pid = process.pid): string {
  const runDir = join(home, ".kobe", "run")
  return fitSocketPath(join(runDir, `bridge-${pid}.sock`), home, "bridge", pid)
}

/**
 * Best-effort sweep of `<home>/.kobe/run/` for `bridge-<pid>.sock` and
 * `mcp-<pid>.json` entries whose owner PID is no longer alive. The
 * normal close path unlinks both files, but SIGKILL'd kobe / kobed
 * runs (oom-killer, terminal closed mid-shutdown, panic) leave them
 * behind, and a single dev day can accumulate dozens of stale entries.
 * Skip our own pid and anything we can't parse — we'd rather underclean
 * than wipe a live peer's file. Errors swallowed: stale-file cleanup
 * must never block daemon startup.
 */
async function sweepStaleRunFiles(runDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(runDir)
  } catch {
    return
  }
  const self = process.pid
  await Promise.all(
    entries.map(async (name) => {
      const match = name.match(/^(?:bridge|mcp)-(\d+)\.(?:sock|json)$/)
      if (!match) return
      const pid = Number(match[1])
      if (!Number.isFinite(pid) || pid === self) return
      try {
        process.kill(pid, 0)
        return // owner still alive
      } catch {
        // ESRCH (no such process) or EPERM — treat both as "safe to
        // sweep." EPERM means we don't own the process, which on macOS
        // happens for `pid 1` and other system pids; the run/ pid is
        // ours, so EPERM almost certainly means "wraparound, different
        // owner, ours is gone."
      }
      await unlink(join(runDir, name)).catch(() => {})
    }),
  )
}

export async function startBridge(orch: Orchestrator, opts: StartBridgeOpts = {}): Promise<BridgeHandles> {
  const home = opts.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const runDir = join(home, ".kobe", "run")
  // mcp-<pid>.json stays under the home dir — claude reads it once and
  // path length isn't an issue for a regular file. Only the unix
  // socket is subject to the 104-byte `sun_path` cap, so route the
  // socket through fitSocketPath; deeply-nested homes get a short
  // `$TMPDIR/kobe-<homeTag>-bridge-<pid>.sock` form instead of failing
  // to listen.
  const socketPath = bridgeSocketPathForHome(home)
  const mcpConfigPath = join(runDir, `mcp-${process.pid}.json`)

  // startBridgeServer already mkdir's the socket's parent; but if the
  // socket fell back to $TMPDIR via fitSocketPath, the home-side runDir
  // still needs to exist for the mcp.json writeFile below.
  await mkdir(runDir, { recursive: true })

  await sweepStaleRunFiles(runDir)

  const server: BridgeServer = await startBridgeServer(orch, socketPath)
  await mkdir(runDir, { recursive: true })

  // The mcp-bridge subcommand only exists in the `kobe` CLI entry
  // (src/cli/index.ts → dist/cli/index.js), not in `kobed`. Resolve
  // it relative to this module so the config is correct regardless
  // of who called startBridge — kobed daemon, TUI no-daemon path, or
  // test fixtures. Extension follows our own (`.ts` in dev, `.js` in
  // the built bundle), keyed off import.meta.url. process.argv[1] is
  // unsafe here: when kobed calls startBridge, argv[1] points at
  // kobed.ts which has no mcp-bridge handler. See KOB-54.
  const moduleExt = import.meta.url.endsWith(".ts") ? ".ts" : ".js"
  const entry = fileURLToPath(new URL(`../../cli/index${moduleExt}`, import.meta.url))
  const mcpConfig = {
    mcpServers: {
      kobe: {
        command: process.execPath,
        args: [entry, "mcp-bridge", `--socket=${socketPath}`],
      },
    },
  }
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8")
  process.env.KOBE_MCP_CONFIG = mcpConfigPath

  return {
    socketPath,
    mcpConfigPath,
    async close() {
      await server.close()
      await unlink(mcpConfigPath).catch(() => {})
    },
  }
}
