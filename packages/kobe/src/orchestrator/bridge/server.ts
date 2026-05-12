/**
 * Bridge RPC server — newline-delimited JSON over a Unix socket.
 *
 * Exposes a tiny RPC surface over the orchestrator so an external
 * process (the `kobe mcp-bridge` subcommand, spawned by claude as an
 * MCP server) can drive kobe in-process without going through any
 * extra IPC layer. The bridge subprocess speaks MCP/JSON-RPC over
 * stdio to claude and translates each tool call into one of the
 * methods below.
 *
 * Request line: {"id":"1","method":"spawn_task","params":{...}}
 * Response line: {"id":"1","result":{...}} | {"id":"1","error":{"message":"..."}}
 *
 * Only minimal happy path is implemented for the first iteration.
 * Hardening (auth token in the path, recursion guard via parent task
 * id, structured errors) belongs in a follow-up once the loop is
 * proven end-to-end.
 */

import { mkdir, unlink } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { dirname } from "node:path"
import type { Orchestrator } from "../core.ts"

interface JsonRpcRequest {
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface BridgeServer {
  readonly socketPath: string
  close(): Promise<void>
}

/**
 * Bind a JSON-line RPC server on `socketPath`. Removes a stale socket
 * file at the path before binding so a previous kobe crash doesn't
 * permanently wedge the same path. Returns a disposer that closes
 * the listener and unlinks the socket.
 */
export async function startBridgeServer(orch: Orchestrator, socketPath: string): Promise<BridgeServer> {
  await mkdir(dirname(socketPath), { recursive: true })
  await unlink(socketPath).catch(() => {})

  // Track live connections so close() can force them shut. server.close()
  // alone only stops accepting new connections — it waits indefinitely
  // for existing sockets to drain, which would deadlock daemon shutdown
  // any time a long-lived MCP bridge client (claude subprocess) was
  // still attached. We destroy the sockets explicitly during close.
  const conns = new Set<Socket>()

  const server: Server = createServer((conn) => {
    conns.add(conn)
    conn.on("close", () => conns.delete(conn))
    let buffer = ""
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8")
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.trim().length > 0) {
          void handleLine(orch, line)
            .then((reply) => conn.write(`${reply}\n`))
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              conn.write(`${JSON.stringify({ error: { message: msg } })}\n`)
            })
        }
        nl = buffer.indexOf("\n")
      }
    })
    conn.on("error", () => {
      // Bridge subprocess exits / claude tears it down — don't crash.
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  return {
    socketPath,
    async close() {
      for (const conn of conns) conn.destroy()
      conns.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
    },
  }
}

async function handleLine(orch: Orchestrator, line: string): Promise<string> {
  let req: JsonRpcRequest
  try {
    req = JSON.parse(line) as JsonRpcRequest
  } catch (err) {
    return JSON.stringify({ error: { message: `bad json: ${err instanceof Error ? err.message : String(err)}` } })
  }
  const id = req.id ?? null
  try {
    const result = await dispatch(orch, req.method, req.params ?? {})
    return JSON.stringify({ id, result })
  } catch (err) {
    return JSON.stringify({
      id,
      error: { message: err instanceof Error ? err.message : String(err) },
    })
  }
}

async function dispatch(orch: Orchestrator, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "list_tasks": {
      return orch.listTasks().map(serializeTask)
    }
    case "get_task": {
      const id = requireString(params, "task_id")
      const task = orch.getTask(id)
      if (!task) throw new Error(`task not found: ${id}`)
      return serializeTask(task)
    }
    case "spawn_task": {
      const repo = requireString(params, "repo")
      const prompt = requireString(params, "prompt")
      const title = optionalString(params, "title")
      const baseRef = optionalString(params, "base_branch")
      const task = await orch.createTask({
        repo,
        prompt,
        ...(title ? { title } : {}),
        ...(baseRef ? { baseRef } : {}),
      })
      // Fire-and-forget: don't block the RPC on the engine starting.
      void orch.runTask(task.id, prompt).catch(() => {})
      return serializeTask(task)
    }
    case "send_message": {
      const id = requireString(params, "task_id")
      const prompt = requireString(params, "prompt")
      await orch.runTask(id, prompt)
      return { ok: true }
    }
    default:
      throw new Error(`unknown method: ${method}`)
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`param '${key}' is required and must be a non-empty string`)
  }
  return v
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  if (v === undefined || v === null || v === "") return undefined
  if (typeof v !== "string") throw new Error(`param '${key}' must be a string`)
  return v
}

function serializeTask(task: {
  id: string
  title: string
  repo: string
  branch: string
  worktreePath: string
  status: string
  sessionId: string | null
}): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    repo: task.repo,
    branch: task.branch,
    worktree_path: task.worktreePath,
    status: task.status,
    session_id: task.sessionId,
  }
}
