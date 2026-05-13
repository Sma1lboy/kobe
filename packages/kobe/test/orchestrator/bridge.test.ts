/**
 * Smoke test for the orchestrator bridge — Unix-socket RPC + MCP
 * config bootstrap. Asserts end-to-end:
 *   1. `startBridge` binds the socket, writes the MCP config, and
 *      exports `KOBE_MCP_CONFIG`.
 *   2. A bare client can call `list_tasks` / `spawn_task` over the
 *      socket and see the orchestrator's store mutate.
 *
 * Uses real `Orchestrator` + `FakeAIEngine` + a tmpdir git repo (same
 * pattern as `core.test.ts`) so the assertion is on actual store
 * behavior, not on a stub.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import { readFile } from "node:fs/promises"
import { connect } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { shortHomeTag } from "../../src/daemon/paths.ts"
import { bridgeSocketPathForHome, startBridge } from "../../src/orchestrator/bridge/index.ts"
import { Orchestrator } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string

class NoopMetadataSuggester extends MetadataSuggester {
  override async suggestBranchSlug(): Promise<string | null> {
    return null
  }

  override async suggestTitle(): Promise<string | null> {
    return null
  }

  override async suggestWorktreeSlug(): Promise<string | null> {
    return null
  }
}

function makeOrchestrator(store: TaskIndexStore): Orchestrator {
  return new Orchestrator({
    engine: new FakeAIEngine(),
    store,
    worktrees: new GitWorktreeManager(),
    metadataSuggester: new NoopMetadataSuggester(),
  })
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-bridge-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.env.KOBE_MCP_CONFIG = undefined
})

/** Round-trip one JSON-line request/response over the bridge socket. */
function call(socketPath: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath)
    let buf = ""
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      const nl = buf.indexOf("\n")
      if (nl !== -1) {
        const line = buf.slice(0, nl)
        try {
          const parsed = JSON.parse(line)
          sock.end()
          if (parsed.error) reject(new Error(parsed.error.message))
          else resolve(parsed.result)
        } catch (err) {
          reject(err)
        }
      }
    })
    sock.on("error", reject)
    sock.on("connect", () => {
      sock.write(`${JSON.stringify({ id: 1, method, params })}\n`)
    })
  })
}

describe("orchestrator bridge", () => {
  test("uses a short socket path when KOBE_HOME_DIR would exceed Unix socket limits", () => {
    const longHome = path.join(
      os.tmpdir(),
      "kobe-bridge-long-home",
      "nested",
      "path",
      "with",
      "enough",
      "segments",
      "to",
      "exceed",
      "socket",
      "limits",
    )
    const socketPath = bridgeSocketPathForHome(longHome, 12345)
    expect(socketPath).toBe(path.join(os.tmpdir(), `kobe-${shortHomeTag(longHome)}-bridge-12345.sock`))
    expect(socketPath.length).toBeLessThanOrEqual(103)
  })

  test("startBridge writes mcp.json and exports KOBE_MCP_CONFIG", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const orch = makeOrchestrator(store)
    const handles = await startBridge(orch, { homeDir })
    try {
      expect(handles.mcpConfigPath).toMatch(/mcp-\d+\.json$/)
      expect(process.env.KOBE_MCP_CONFIG).toBe(handles.mcpConfigPath)
      const cfg = JSON.parse(await readFile(handles.mcpConfigPath, "utf8")) as {
        mcpServers: { kobe: { command: string; args: string[] } }
      }
      expect(cfg.mcpServers.kobe.args).toContain("mcp-bridge")
      expect(cfg.mcpServers.kobe.args.some((a) => a.startsWith("--socket="))).toBe(true)
    } finally {
      await handles.close()
      orch.dispose()
    }
  })

  test("list_tasks → spawn_task → list_tasks roundtrip mutates the store", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const orch = makeOrchestrator(store)
    const handles = await startBridge(orch, { homeDir })
    try {
      const empty = (await call(handles.socketPath, "list_tasks", {})) as unknown[]
      expect(empty).toEqual([])

      const created = (await call(handles.socketPath, "spawn_task", {
        repo,
        prompt: "investigate flake",
        title: "flake hunt",
      })) as { id: string; title: string; repo: string; status: string }
      expect(created.title).toBe("flake hunt")
      expect(created.repo).toBe(repo)
      expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/i) // ulid

      const listed = (await call(handles.socketPath, "list_tasks", {})) as Array<{ id: string }>
      expect(listed.map((t) => t.id)).toContain(created.id)
    } finally {
      await handles.close()
      orch.dispose()
    }
  })

  test("unknown method returns a structured error", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const orch = makeOrchestrator(store)
    const handles = await startBridge(orch, { homeDir })
    try {
      await expect(call(handles.socketPath, "no_such_method", {})).rejects.toThrow(/unknown method/)
    } finally {
      await handles.close()
      orch.dispose()
    }
  })
})
