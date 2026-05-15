import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { type Server, createServer } from "node:net"
import { dirname } from "node:path"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { OrchestratorEvent } from "../types/engine.ts"
import { tabKey, tabKeyMatchesTask } from "../types/tab-key.ts"
import type { Task } from "../types/task.ts"
import type { ClientState, DaemonClientConnection, DaemonContext } from "./context.ts"
import { daemonHandlers } from "./handlers/index.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import { type PlanUsagePoller, createPlanUsagePoller } from "./plan-usage-poller.ts"
import { frameToLine, normalizeEventForWire, serializeTask } from "./protocol.ts"
import type { DaemonFrame } from "./protocol.ts"
import { type RcBridge, createRcBridge } from "./rc-bridge.ts"

export type { DaemonClientConnection } from "./context.ts"

export interface DaemonServerOptions {
  readonly socketPath?: string
  readonly pidPath?: string
  readonly homeDir?: string
  readonly startedAt?: Date
  readonly onStop?: () => void | Promise<void>
  /**
   * Override the plan-usage poller. Tests inject a fake fetcher here so
   * the daemon doesn't actually hit Anthropic's API.
   */
  readonly planUsagePoller?: PlanUsagePoller
  /**
   * Override the remote-control bridge manager (KOB-62). Tests pass a
   * fake whose `start`/`stop` resolve synchronously without spawning
   * the real `claude remote-control` subprocess.
   */
  readonly rcBridge?: RcBridge
}

export interface DaemonServer {
  readonly socketPath: string
  readonly pidPath: string
  readonly startedAt: Date
  readonly clients: ReadonlySet<DaemonClientConnection>
  close(): Promise<void>
}

export async function startDaemonServer(orch: Orchestrator, options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath(options.homeDir)
  const pidPath = options.pidPath ?? defaultDaemonPidPath(options.homeDir)
  const startedAt = options.startedAt ?? new Date()
  const clients = new Set<ClientState>()
  let nextClientId = 1

  await mkdir(dirname(socketPath), { recursive: true })
  await mkdir(dirname(pidPath), { recursive: true })
  await unlink(socketPath).catch(() => {})

  const server: Server = createServer((socket) => {
    const client: ClientState = {
      id: nextClientId++,
      connectedAt: new Date(),
      socket,
      buffer: "",
      subscriptions: new Map(),
    }
    clients.add(client)

    socket.on("data", (chunk) => {
      client.buffer += chunk.toString("utf8")
      drainClientBuffer(client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      for (const unsub of client.subscriptions.values()) unsub()
      client.subscriptions.clear()
      clients.delete(client)
    })
  })

  // Plan-usage poller — periodically refreshes claude plan utilization
  // and broadcasts the snapshot to every attached client. Starts after
  // `serverApi` is built so `broadcast` is in scope. The first tick
  // fires immediately so `hello` responses can carry a fresh value
  // shortly after daemon boot.
  const planUsagePoller =
    options.planUsagePoller ??
    createPlanUsagePoller({
      onUpdate: (usage) => broadcast(clients, { type: "event", name: "plan.usage", payload: { usage } }),
    })

  // Remote-control bridge — off until the user enables it from settings.
  // Each transition is broadcast so all attached TUIs repaint the chip
  // and dialog at once. Spawning the real `claude remote-control` only
  // happens on `rcBridge.start`; constructing the manager is free.
  const rcBridge = options.rcBridge ?? createRcBridge()
  rcBridge.onChange((status) => broadcast(clients, { type: "event", name: "rcBridge.changed", payload: { status } }))

  const serverApi: DaemonServer = {
    socketPath,
    pidPath,
    startedAt,
    clients,
    async close() {
      planUsagePoller.stop()
      // Stop the bridge before the socket so claude.ai gets the proper
      // environment-deregistration call and we don't leak an "online"
      // worker on the cloud side after the daemon exits.
      try {
        await rcBridge.stop()
      } catch {
        /* best-effort — daemon shutdown should never block on bridge teardown */
      }
      broadcast(clients, { type: "event", name: "daemon.stopping", payload: {} })
      // End attached client sockets BEFORE closing the server. server.close()
      // waits for every active connection to drain — if we close it first,
      // any TUI that doesn't disconnect on `daemon.stopping` will deadlock
      // shutdown forever (this was the root cause of `kobe daemon restart` hangs).
      for (const client of Array.from(clients)) {
        for (const unsub of client.subscriptions.values()) unsub()
        client.subscriptions.clear()
        client.socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
      await unlink(pidPath).catch(() => {})
    },
  }
  planUsagePoller.start()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, () => {
      server.removeListener("error", reject)
      resolve()
    })
  })
  await writeFile(pidPath, `${process.pid}\n`, "utf8")

  async function stopSoon(): Promise<void> {
    await options.onStop?.()
    setTimeout(() => {
      void serverApi.close()
    }, 0).unref()
  }

  // Build the request context once. Handlers receive this on every call
  // instead of capturing the startDaemonServer closure directly — keeps
  // the per-category handler modules under `handlers/` from depending on
  // anything inside this function's scope.
  const ctx: DaemonContext = {
    orch,
    clients,
    planUsagePoller,
    rcBridge,
    socketPath,
    startedAt,
    stopSoon,
    broadcast: (frame) => broadcast(clients, frame),
    broadcastTaskUpdated: (taskId) => broadcastTaskUpdated(orch, clients, taskId),
    subscribeClientToTask: (client, task) => subscribeClientToTask(orch, client, task),
    subscribeClientToTab: (client, taskId, tabId) => subscribeClientToTab(orch, client, taskId, tabId),
    unsubscribeClientFromTask: (client, taskId) => unsubscribeClientFromTask(client, taskId),
  }

  async function handleRequest(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<void> {
    try {
      const handler = daemonHandlers[req.name]
      if (!handler) throw new Error(`unknown daemon request: ${req.name}`)
      const payload = await handler(req, client, ctx)
      writeFrame(client, { type: "response", id: req.id, name: req.name, payload })
    } catch (err) {
      writeFrame(client, {
        type: "response",
        id: req.id,
        name: req.name,
        error: {
          message: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        },
      })
    }
  }

  function drainClientBuffer(client: ClientState): void {
    let nl = client.buffer.indexOf("\n")
    while (nl !== -1) {
      const line = client.buffer.slice(0, nl)
      client.buffer = client.buffer.slice(nl + 1)
      if (line.trim().length > 0) {
        try {
          const frame = JSON.parse(line) as DaemonFrame
          if (frame.type !== "request") throw new Error("daemon only accepts request frames from clients")
          void handleRequest(frame, client)
        } catch (err) {
          writeFrame(client, {
            type: "response",
            id: "parse-error",
            error: { message: err instanceof Error ? err.message : String(err) },
          })
        }
      }
      nl = client.buffer.indexOf("\n")
    }
  }

  return serverApi
}

export async function readPidFile(pidPath: string): Promise<number | null> {
  try {
    const raw = await readFile(pidPath, "utf8")
    const pid = Number(raw.trim())
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function subscribeClientToTask(orch: Orchestrator, client: ClientState, task: Task): void {
  for (const tab of task.tabs) subscribeClientToTab(orch, client, task.id, tab.id)
}

function subscribeClientToTab(orch: Orchestrator, client: ClientState, taskId: string, tabId: string): void {
  const key = tabKey(taskId, tabId)
  if (client.subscriptions.has(key)) return
  const unsub = orch.subscribeEvents(
    taskId,
    (ev: OrchestratorEvent) => writeFrame(client, normalizeEventForWire(taskId, tabId, ev)),
    tabId,
  )
  client.subscriptions.set(key, unsub)
}

/**
 * Fetch the post-mutation task from the orchestrator and broadcast it
 * as a `task.updated` delta to every attached client. Called by handlers
 * that change task fields (pin, permission mode, model, tab create /
 * close / activate / rename, session open) so RemoteOrchestrator
 * mirrors of the same task stay in sync — otherwise an optimistic
 * client-side update (e.g. Chat's `setActiveTabIdLocal`) gets reverted
 * by the next reactive read of the stale tasks signal.
 *
 * Silent if the task no longer exists (e.g. raced with a delete) —
 * the deletion broadcast handles that path.
 */
function broadcastTaskUpdated(orch: Orchestrator, clients: ReadonlySet<ClientState>, taskId: string): void {
  const task = orch.getTask(taskId)
  if (!task) return
  broadcast(clients, { type: "event", name: "task.updated", payload: { taskId, task: serializeTask(task) } })
}

function unsubscribeClientFromTask(client: ClientState, taskId: string): void {
  for (const [key, unsub] of client.subscriptions) {
    if (!tabKeyMatchesTask(key, taskId)) continue
    unsub()
    client.subscriptions.delete(key)
  }
}

function writeFrame(client: Pick<ClientState, "socket">, frame: DaemonFrame): void {
  client.socket.write(frameToLine(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  for (const client of clients) writeFrame(client, frame)
}
