/**
 * kobe daemon server (v0.6).
 *
 * v0.5 was a chat-stream broker on top of a Unix socket: clients
 * subscribed to per-tab event buses, the daemon hosted the engine
 * subprocess and forwarded `assistant.delta` / `tool.start` / etc.
 * v0.6 has none of that — claude lives in tmux, so the daemon's
 * only job is to be the single writer for the task index.
 *
 * The RPC surface is now: hello / daemon.status / daemon.stop +
 * task CRUD + subscribe. Everything else (chat.*, pr.*, merge.*,
 * rcBridge.*, plan-usage poll) is gone with the chat pane.
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { dirname } from "node:path"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { Task, VendorId } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { logDaemonError } from "./crash-log.ts"
import { DaemonEventBus } from "./event-bus.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import {
  CHANNEL_NAMES,
  DAEMON_PROTOCOL_VERSION,
  type DaemonFrame,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  frameToLine,
  isProtocolCompatible,
  serializeTask,
} from "./protocol.ts"

/** How often the daemon re-checks npm for a newer kobe (6h — `latest` rarely moves). */
const DEFAULT_UPDATE_POLL_MS = 6 * 60 * 60 * 1000

export interface DaemonServerOptions {
  readonly socketPath?: string
  readonly pidPath?: string
  readonly homeDir?: string
  readonly startedAt?: Date
  readonly onStop?: () => void | Promise<void>
  /** Override the npm version check (tests inject a fake to avoid the network). */
  readonly checkUpdate?: () => Promise<UpdateInfo | null>
  /** Re-check interval in ms; `0` disables the poller. Defaults to 6h. */
  readonly updatePollMs?: number
}

export interface DaemonServer {
  readonly socketPath: string
  readonly pidPath: string
  readonly startedAt: Date
  readonly clients: ReadonlySet<DaemonClientConnection>
  close(): Promise<void>
}

export interface DaemonClientConnection {
  readonly id: number
  readonly connectedAt: Date
}

type ClientState = DaemonClientConnection & {
  socket: Socket
  buffer: string
  /** True once the client has called `subscribe` (broadcast target). */
  subscribed: boolean
}

export async function startDaemonServer(orch: Orchestrator, options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath(options.homeDir)
  const pidPath = options.pidPath ?? defaultDaemonPidPath(options.homeDir)
  const startedAt = options.startedAt ?? new Date()
  const clients = new Set<ClientState>()
  let nextClientId = 1

  // Channel event bus (KOB-246): the single hub the daemon publishes push
  // events to. One sink fans each publish out to subscribed sockets; the
  // bus also caches the last value per channel so a late subscriber gets
  // the current value on connect. `task.snapshot` is channel #1; new
  // channels just call `bus.publish` (see protocol.ts ChannelPayloads).
  const bus = new DaemonEventBus()
  bus.onPublish((event) => {
    broadcast(clients, { type: "event", name: event.channel, payload: event.payload })
  })

  await mkdir(dirname(socketPath), { recursive: true })
  await mkdir(dirname(pidPath), { recursive: true })
  await unlink(socketPath).catch(() => {})

  const server: Server = createServer((socket) => {
    const client: ClientState = {
      id: nextClientId++,
      connectedAt: new Date(),
      socket,
      buffer: "",
      subscribed: false,
    }
    clients.add(client)

    socket.on("data", (chunk) => {
      client.buffer += chunk.toString("utf8")
      drainClientBuffer(client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      clients.delete(client)
    })
  })

  // Push every task-list change to subscribed clients as a snapshot via
  // the bus. v0.5 sent per-task deltas; re-sending the full list on every
  // mutation is cheaper than diffing for this small surface — clients
  // re-derive their delta locally. `subscribeTasks` fires once eagerly
  // with the current list, which warms the bus's last-value cache so a
  // subscriber connecting before the first mutation still replays the
  // current tasks (no cold cache).
  const unsubscribeStore = orch.subscribeTasks((snapshot) => {
    bus.publish("task.snapshot", { tasks: snapshot.map(serializeTask) })
  })

  // Daemon-owned update check (KOB): poll npm once on start + on an interval
  // and publish to the `update` channel, so every `kobe tasks` pane subscribes
  // instead of hitting the registry itself. A failure is logged, not fatal;
  // the bus caches the last value for late subscribers like any other channel.
  const checkUpdate = options.checkUpdate ?? checkLatestVersion
  const updatePollMs = options.updatePollMs ?? DEFAULT_UPDATE_POLL_MS
  const pollUpdate = (): void => {
    void checkUpdate()
      .then((info) => bus.publish("update", { info }))
      .catch((err) => logDaemonError("update-poller", err))
  }
  let updateTimer: ReturnType<typeof setInterval> | null = null
  if (updatePollMs > 0) {
    pollUpdate()
    updateTimer = setInterval(pollUpdate, updatePollMs)
    updateTimer.unref?.()
  }

  const serverApi: DaemonServer = {
    socketPath,
    pidPath,
    startedAt,
    clients,
    async close() {
      unsubscribeStore()
      if (updateTimer) clearInterval(updateTimer)
      broadcast(clients, { type: "event", name: "daemon.stopping", payload: {} })
      for (const client of Array.from(clients)) {
        client.socket.destroy()
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
      await unlink(pidPath).catch(() => {})
    },
  }

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
      serverApi.close().catch((err) => logDaemonError("daemon-shutdown", err))
    }, 0).unref()
  }

  async function dispatch(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<unknown> {
    const payload = objectPayload(req.payload)
    switch (req.name) {
      case "hello": {
        // Negotiate a compatibility RANGE (see protocol.ts isProtocolCompatible).
        // A client that omits a field is tolerated: a missing version means
        // "current", a missing min means "same as its version". Only a true
        // range mismatch is rejected, with a clear upgrade message.
        const clientVersion =
          typeof payload.protocolVersion === "number" ? payload.protocolVersion : DAEMON_PROTOCOL_VERSION
        const clientMin = typeof payload.minProtocolVersion === "number" ? payload.minProtocolVersion : clientVersion
        if (
          !isProtocolCompatible({
            localVersion: DAEMON_PROTOCOL_VERSION,
            localMin: MIN_COMPATIBLE_PROTOCOL_VERSION,
            remoteVersion: clientVersion,
            remoteMin: clientMin,
          })
        ) {
          throw new Error(
            `daemon is protocol v${DAEMON_PROTOCOL_VERSION} (min v${MIN_COMPATIBLE_PROTOCOL_VERSION}); this client is v${clientVersion} (min v${clientMin}). Upgrade your kobe.`,
          )
        }
        return {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
          capabilities: [...CHANNEL_NAMES],
          daemonPid: process.pid,
          clientId: client.id,
          tasks: orch.listTasks().map(serializeTask),
        }
      }
      case "daemon.status":
        return {
          daemonPid: process.pid,
          uptimeMs: Date.now() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          attachedClients: clients.size,
          taskCount: orch.listTasks().length,
          socketPath,
        }
      case "daemon.stop":
        await stopSoon()
        return {}
      case "task.list":
        return { tasks: orch.listTasks().map(serializeTask) }
      case "task.get": {
        const taskId = requireString(payload, "taskId")
        const task = orch.getTask(taskId)
        if (!task) throw new Error(`task not found: ${taskId}`)
        return { task: serializeTask(task) }
      }
      case "task.create": {
        const repo = requireString(payload, "repo")
        const task = await orch.createTask({
          repo,
          title: optionalString(payload, "title"),
          branch: optionalString(payload, "branch"),
          baseRef: optionalString(payload, "baseRef"),
          vendor: optionalVendor(payload, "vendor"),
        })
        return { taskId: task.id, task: serializeTask(task) }
      }
      case "task.archive": {
        const taskId = requireString(payload, "taskId")
        await orch.setArchived(taskId, optionalBoolean(payload, "archived"))
        return {}
      }
      case "task.rename": {
        const taskId = requireString(payload, "taskId")
        await orch.setTitle(taskId, requireString(payload, "title"))
        return {}
      }
      case "task.setBranch": {
        const taskId = requireString(payload, "taskId")
        await orch.setBranch(taskId, requireString(payload, "branch"))
        return {}
      }
      case "task.setVendor": {
        const taskId = requireString(payload, "taskId")
        const vendor = optionalVendor(payload, "vendor")
        if (!vendor) throw new Error("task.setVendor: vendor is required")
        await orch.setVendor(taskId, vendor)
        return {}
      }
      case "task.delete": {
        const taskId = requireString(payload, "taskId")
        await orch.deleteTask(taskId, { force: optionalBoolean(payload, "force") })
        return {}
      }
      case "task.pin": {
        const taskId = requireString(payload, "taskId")
        await orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
        return {}
      }
      case "task.status": {
        const taskId = requireString(payload, "taskId")
        const status = requireString(payload, "status")
        if (
          status !== "backlog" &&
          status !== "in_progress" &&
          status !== "in_review" &&
          status !== "done" &&
          status !== "canceled" &&
          status !== "error"
        ) {
          throw new Error("status must be a TaskStatus")
        }
        await orch.setStatus(taskId, status)
        return {}
      }
      case "task.ensureMain": {
        const repo = requireString(payload, "repo")
        const task = await orch.ensureMainTask(repo)
        return { task: serializeTask(task) }
      }
      case "task.ensureWorktree": {
        const taskId = requireString(payload, "taskId")
        const path = await orch.ensureWorktree(taskId)
        return { worktreePath: path }
      }
      case "worktree.discoverAdoptable": {
        const repo = requireString(payload, "repo")
        const worktrees = await orch.discoverAdoptableWorktrees(repo)
        return { worktrees }
      }
      case "worktree.adopt": {
        const task = await orch.adoptWorktree({
          repo: requireString(payload, "repo"),
          worktreePath: requireString(payload, "worktreePath"),
          branch: optionalString(payload, "branch"),
          vendor: optionalVendor(payload, "vendor"),
          title: optionalString(payload, "title"),
        })
        return { task: serializeTask(task) }
      }
      case "task.setActive": {
        // Pure UI/session focus — not a task-index property — so it lives on
        // the bus, not the orchestrator. Publishing caches the last value so
        // a late-subscribing Tasks pane gets the current focus on connect
        // and every pane highlights the same active task (KOB-247).
        bus.publish("active-task", { taskId: optionalString(payload, "taskId") ?? null })
        return {}
      }
      case "subscribe": {
        client.subscribed = true
        // Replay the current value of every populated channel so a late
        // subscriber hydrates without a separate round trip — generalized
        // from the old single task.snapshot send (KOB-246). `payload.channels`
        // is accepted for forward-compat (a future per-channel filter) but
        // currently ignored: every subscriber gets every channel, exactly
        // as before. The bus cache is warm (subscribeTasks' eager fire).
        for (const event of bus.snapshot()) {
          writeFrame(client, { type: "event", name: event.channel, payload: event.payload })
        }
        return {}
      }
      default:
        throw new Error(`unknown daemon request: ${(req as { name: string }).name}`)
    }
  }

  async function handleRequest(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<void> {
    try {
      const payload = await dispatch(req, client)
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

function writeFrame(client: Pick<ClientState, "socket">, frame: DaemonFrame): void {
  client.socket.write(frameToLine(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  for (const client of clients) {
    if (!client.subscribed && frame.type === "event") continue
    writeFrame(client, frame)
  }
}

function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {}
  return payload as Record<string, unknown>
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`)
  return value
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

function optionalVendor(payload: Record<string, unknown>, key: string): VendorId | undefined {
  const value = optionalString(payload, key)
  if (value !== undefined && value !== "claude" && value !== "codex") {
    throw new Error(`${key} '${value}' is not a supported vendor (expected: claude, codex)`)
  }
  return value
}
