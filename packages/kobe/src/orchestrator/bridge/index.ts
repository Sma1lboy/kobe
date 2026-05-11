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

import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
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

export async function startBridge(orch: Orchestrator, opts: StartBridgeOpts = {}): Promise<BridgeHandles> {
  const home = opts.homeDir ?? process.env.KOBE_HOME_DIR ?? homedir()
  const runDir = join(home, ".kobe", "run")
  // mcp-<pid>.json stays under the home dir — claude reads it once and
  // path length isn't an issue for a regular file. Only the unix
  // socket is subject to the 104-byte `sun_path` cap, so route the
  // socket through fitSocketPath; deeply-nested homes get a short
  // `$TMPDIR/kobe-<homeTag>-bridge-<pid>.sock` form instead of failing
  // to listen.
  const socketPath = fitSocketPath(join(runDir, `bridge-${process.pid}.sock`), home, "bridge", process.pid)
  const mcpConfigPath = join(runDir, `mcp-${process.pid}.json`)

  // startBridgeServer already mkdir's the socket's parent; but if the
  // socket fell back to $TMPDIR via fitSocketPath, the home-side runDir
  // still needs to exist for the mcp.json writeFile below.
  await mkdir(runDir, { recursive: true })

  const server: BridgeServer = await startBridgeServer(orch, socketPath)

  // process.argv[1] is the script entry. In the built binary it's
  // `dist/index.js`; in `bun run dev` it's `src/cli/index.ts`. Use
  // process.execPath as the interpreter so the same row works in
  // both modes without a packaged shim.
  const entry = process.argv[1] ?? ""
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
    },
  }
}
