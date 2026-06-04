/**
 * Daemon-owned web extension.
 *
 * kobe's daemon is already the server: it owns task state, RPC dispatch, and
 * channel pub/sub. The browser dashboard is just another daemon transport
 * layered on top of the same orchestrator + event bus, not a separate bridge
 * service.
 */

import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import { interactiveEngineCommand } from "@/engine/interactive-command"
import type { Orchestrator } from "@/orchestrator/core"
import { resolveRepoInit } from "@/state/repo-init"
import { runTmuxCapturing } from "@/tmux/client"
import { ensureSession, newChatTab, sessionExists, tmuxSessionName } from "@/tui/panes/terminal/tmux"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"
import { ALL_VENDORS } from "@/types/vendor"
import { handleDiffRequest } from "@/web/diff"
import { handleNotesRequest } from "@/web/notes"
import type { DaemonEventBus } from "./event-bus.ts"
import type { DaemonRequestName } from "./protocol.ts"
import { serializeTask } from "./protocol.ts"

export const WEB_HEALTH_MARKER = "kobe-web"
export const WEB_HEALTH_PATH = "/__kobe_web"

export interface DaemonWebOptions {
  port?: number
  staticDir?: string
  takeover?: boolean
}

export interface DaemonWebServer {
  readonly running: boolean
  readonly port: number | null
  start(opts?: DaemonWebOptions): Promise<{ port: number }>
  close(): void
}

type RpcDispatch = (name: DaemonRequestName, payload?: unknown) => Promise<unknown>

interface Deps {
  orch: Orchestrator
  bus: DaemonEventBus
  snapshot: () => unknown
  rpc: RpcDispatch
  onStarted?: () => void
  onStopped?: () => void
}

interface WebTab {
  readonly index: number
  readonly name: string
  readonly active: boolean
}

function sseResponse(bus: DaemonEventBus, snapshot: () => unknown): Response {
  let unsubscribe: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const send = (type: string, data: unknown): void => {
        controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      send("snapshot", snapshot())
      unsubscribe = bus.onPublish((event) => send("channel", event))
      heartbeat = setInterval(() => controller.enqueue(enc.encode(": ping\n\n")), 15_000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      unsubscribe?.()
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

async function rpcResponse(req: Request, rpc: RpcDispatch): Promise<Response> {
  try {
    const { name, payload } = (await req.json()) as { name?: DaemonRequestName; payload?: unknown }
    if (!name) return Response.json({ error: "missing rpc name" }, { status: 400 })
    const result = await rpc(name, payload)
    return Response.json({ result })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

function taskOrThrow(orch: Orchestrator, taskId: string) {
  const task = orch.getTask(taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  return task
}

async function ensureTaskWorktree(orch: Orchestrator, taskId: string): Promise<string> {
  const task = taskOrThrow(orch, taskId)
  if (task.worktreePath) return task.worktreePath
  const worktree = await orch.ensureWorktree(taskId)
  if (!worktree) throw new Error(`task ${taskId} has no worktree`)
  return worktree
}

async function ensureTaskSession(
  orch: Orchestrator,
  taskId: string,
): Promise<{ session: string; worktreePath: string }> {
  const task = taskOrThrow(orch, taskId)
  const worktreePath = await ensureTaskWorktree(orch, taskId)
  const session = tmuxSessionName(taskId)
  if (!(await sessionExists(session))) {
    const init = resolveRepoInit(task.repo ?? "", worktreePath)
    const ok = await ensureSession({
      name: session,
      cwd: worktreePath,
      command: interactiveEngineCommand(task.vendor),
      taskId,
      vendor: task.vendor,
      initScript: init.initScript,
    })
    if (!ok) throw new Error(`failed to start tmux session for ${taskId}`)
  }
  return { session, worktreePath }
}

async function sessionResponse(req: Request, orch: Orchestrator): Promise<Response> {
  try {
    const { taskId } = (await req.json()) as { taskId?: string }
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await ensureTaskSession(orch, taskId))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

function shellQuote(argv: readonly string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_/.:=-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ")
}

async function engineSpec(taskId: string, orch: Orchestrator): Promise<{ cwd: string; command: string[] }> {
  const task = taskOrThrow(orch, taskId)
  const worktree = await ensureTaskWorktree(orch, taskId)
  const argv = [...interactiveEngineCommand(task.vendor)]
  const init = resolveRepoInit(task.repo ?? "", worktree)
  const quoted = shellQuote(argv)
  const script = init.initScript?.trim() ? `${init.initScript}\n${quoted}` : quoted
  const shell = process.env.SHELL?.trim() || "/bin/zsh"
  return { cwd: worktree, command: [shell, "-ilc", script] }
}

async function engineSpecResponse(url: URL, orch: Orchestrator): Promise<Response> {
  try {
    const taskId = url.searchParams.get("taskId")
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await engineSpec(taskId, orch))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function terminalSpecResponse(url: URL, orch: Orchestrator): Promise<Response> {
  try {
    const taskId = url.searchParams.get("taskId")
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    const worktree = await ensureTaskWorktree(orch, taskId)
    const shell = process.env.SHELL?.trim() || "/bin/zsh"
    return Response.json({ cwd: worktree, command: [shell, "-il"] })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function listTaskTabs(orch: Orchestrator, taskId: string): Promise<{ session: string; tabs: WebTab[] }> {
  const { session } = await ensureTaskSession(orch, taskId)
  const { code, stdout } = await runTmuxCapturing([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    "#{window_index}\t#{window_name}\t#{window_active}",
  ])
  const tabs: WebTab[] = []
  if (code === 0) {
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue
      const [idxRaw, name = "", active = "0"] = line.split("\t")
      const index = Number.parseInt((idxRaw ?? "").trim(), 10)
      if (!Number.isInteger(index)) continue
      tabs.push({ index, name: name.trim(), active: active.trim() === "1" })
    }
  }
  return { session, tabs }
}

async function tabsResponse(req: Request, url: URL, orch: Orchestrator): Promise<Response> {
  try {
    if (req.method === "GET") {
      const taskId = url.searchParams.get("taskId")
      if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
      return Response.json(await listTaskTabs(orch, taskId))
    }
    if (req.method === "POST") {
      const { taskId, vendor } = (await req.json()) as { taskId?: string; vendor?: string }
      if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
      const { session } = await ensureTaskSession(orch, taskId)
      const safeVendor = ALL_VENDORS.includes(vendor as VendorId) ? (vendor as VendorId) : undefined
      await newChatTab(session, safeVendor ?? taskOrThrow(orch, taskId).vendor ?? DEFAULT_TASK_VENDOR)
      return Response.json(await listTaskTabs(orch, taskId))
    }
    return new Response("method not allowed", { status: 405 })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function staticResponse(pathname: string, staticDir: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname
  const resolved = normalize(join(staticDir, rel))
  if (!resolved.startsWith(staticDir)) return new Response("forbidden", { status: 403 })
  const file = Bun.file(existsSync(resolved) ? resolved : join(staticDir, "index.html"))
  if (!(await file.exists())) {
    return new Response("kobe web assets not built — run `bun --filter kobe-web build`", { status: 503 })
  }
  return new Response(file)
}

async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    return out
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid)
  } catch {
    return []
  }
}

async function takeoverPort(port: number): Promise<void> {
  let body: string
  try {
    const res = await fetch(`http://localhost:${port}${WEB_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(800),
    })
    body = (await res.text()).trim()
  } catch {
    return
  }
  if (body !== WEB_HEALTH_MARKER) {
    throw new Error(`port ${port} is in use by a non-kobe service; refusing to replace it`)
  }
  const pids = await pidsOnPort(port)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await pidsOnPort(port)).length === 0) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function createDaemonWebServer(deps: Deps): DaemonWebServer {
  let server: ReturnType<typeof Bun.serve> | null = null
  let boundPort: number | null = null

  return {
    get running() {
      return server !== null
    },
    get port() {
      return boundPort
    },
    async start(opts: DaemonWebOptions = {}) {
      if (server) return { port: boundPort ?? opts.port ?? 5173 }
      const port = opts.port ?? 5173
      const staticDir = opts.staticDir ? normalize(opts.staticDir) : undefined
      if (opts.takeover !== false) await takeoverPort(port)
      server = Bun.serve({
        port,
        idleTimeout: 0,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === WEB_HEALTH_PATH) return new Response(WEB_HEALTH_MARKER)
          if (url.pathname === "/events") return sseResponse(deps.bus, deps.snapshot)
          if (url.pathname === "/api/rpc" && req.method === "POST") return rpcResponse(req, deps.rpc)
          if (url.pathname === "/api/session" && req.method === "POST") return sessionResponse(req, deps.orch)
          if (url.pathname === "/api/engine-spec" && req.method === "GET") return engineSpecResponse(url, deps.orch)
          if (url.pathname === "/api/terminal-spec" && req.method === "GET") return terminalSpecResponse(url, deps.orch)
          if (url.pathname === "/api/tabs") return tabsResponse(req, url, deps.orch)
          const notes = await handleNotesRequest(req, url)
          if (notes) return notes
          const diff = await handleDiffRequest(req, url)
          if (diff) return diff
          if (staticDir) return staticResponse(url.pathname, staticDir)
          return new Response("not found", { status: 404 })
        },
      })
      boundPort = server.port ?? port
      deps.onStarted?.()
      return { port: boundPort }
    },
    close() {
      server?.stop(true)
      server = null
      boundPort = null
      deps.onStopped?.()
    },
  }
}
