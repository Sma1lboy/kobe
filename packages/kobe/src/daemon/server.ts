import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { dirname } from "node:path"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { Message, OrchestratorEvent, UserInputResponse } from "../types/engine.ts"
import type { Task } from "../types/task.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import {
  DAEMON_PROTOCOL_VERSION,
  frameToLine,
  normalizeEventForWire,
  serializeMessages,
  serializeTask,
} from "./protocol.ts"
import type { DaemonFrame } from "./protocol.ts"

export interface DaemonServerOptions {
  readonly socketPath?: string
  readonly pidPath?: string
  readonly homeDir?: string
  readonly startedAt?: Date
  readonly onStop?: () => void | Promise<void>
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
  /**
   * Active per-tab subscriptions for this client. Keyed by
   * `${taskId}:${tabId}` so re-subscribing the same tab is a no-op
   * (prevents the chat.tab.create dupe-subscribe leak — see #3).
   */
  subscriptions: Map<string, () => void>
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
      drainClientBuffer(orch, serverApi, client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      for (const unsub of client.subscriptions.values()) unsub()
      client.subscriptions.clear()
      clients.delete(client)
    })
  })

  const serverApi: DaemonServer = {
    socketPath,
    pidPath,
    startedAt,
    clients,
    async close() {
      broadcast(clients, { type: "event", name: "daemon.stopping", payload: {} })
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const client of Array.from(clients)) {
        for (const unsub of client.subscriptions.values()) unsub()
        client.subscriptions.clear()
        client.socket.end()
      }
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
      void serverApi.close()
    }, 0).unref()
  }

  async function dispatch(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<unknown> {
    const payload = objectPayload(req.payload)
    switch (req.name) {
      case "hello": {
        // Enrich the handshake so a fresh attach only needs `hello`
        // then `subscribe` instead of `hello` → `task.list` → N×
        // `chat.input.pending` round-trips. Old clients ignore the
        // extra fields; the legacy `task.list` and `chat.input.pending`
        // request handlers remain in place for backwards compat.
        const tasks = orch.listTasks()
        const pending: Record<string, ReturnType<typeof orch.peekPendingInput>> = {}
        for (const task of tasks) {
          const entries = orch.peekPendingInput(task.id)
          if (entries.length > 0) pending[task.id] = entries
        }
        return {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          daemonPid: process.pid,
          clientId: client.id,
          tasks: tasks.map(serializeTask),
          pending,
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
      case "task.spawn": {
        const repo = requireString(payload, "repo")
        const task = await orch.createTask({
          repo,
          prompt: optionalString(payload, "prompt"),
          title: optionalString(payload, "title"),
          branch: optionalString(payload, "branch"),
          baseRef: optionalString(payload, "baseRef"),
        })
        // Subscribe EVERY attached client to the new task's tabs, not
        // just the spawning client. Otherwise other TUIs see task.created
        // but never receive chat.delta / chat.event for the new task —
        // multi-attach real-time sync silently breaks.
        for (const c of clients) subscribeClientToTask(orch, c, task)
        broadcast(clients, { type: "event", name: "task.created", payload: { task: serializeTask(task) } })
        return { taskId: task.id, task: serializeTask(task) }
      }
      case "task.archive": {
        const taskId = requireString(payload, "taskId")
        const archived = optionalBoolean(payload, "archived")
        await orch.setArchived(taskId, archived)
        const task = orch.getTask(taskId)
        if (task)
          broadcast(clients, { type: "event", name: "task.updated", payload: { taskId, task: serializeTask(task) } })
        return {}
      }
      case "task.rename": {
        const taskId = requireString(payload, "taskId")
        await orch.setTitle(taskId, requireString(payload, "title"))
        const task = orch.getTask(taskId)
        if (task)
          broadcast(clients, { type: "event", name: "task.updated", payload: { taskId, task: serializeTask(task) } })
        return {}
      }
      case "task.delete": {
        const taskId = requireString(payload, "taskId")
        await orch.deleteTask(taskId)
        for (const c of clients) unsubscribeClientFromTask(c, taskId)
        broadcast(clients, { type: "event", name: "task.deleted", payload: { taskId } })
        return {}
      }
      case "task.pin": {
        const taskId = requireString(payload, "taskId")
        await orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "task.permissionMode": {
        const taskId = requireString(payload, "taskId")
        const mode = optionalString(payload, "mode")
        if (mode !== undefined && mode !== "default" && mode !== "plan") throw new Error("mode must be default or plan")
        await orch.setPermissionMode(taskId, mode)
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "task.model": {
        const taskId = requireString(payload, "taskId")
        await orch.setModel(taskId, optionalString(payload, "model"))
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "task.ensureMain": {
        const task = await orch.ensureMainTask(requireString(payload, "repo"))
        return { task: serializeTask(task) }
      }
      case "chat.tab.create": {
        const taskId = requireString(payload, "taskId")
        const tab = await orch.createTab(taskId, { title: optionalString(payload, "title") })
        // Subscribe EVERY client to JUST the new tab. Subscribing the
        // whole task again would re-add a listener for every existing
        // tab on every create — N tabs ⇒ N redundant callbacks per
        // delta. Per-tab + dedupe (the Map key) prevents that leak.
        for (const c of clients) subscribeClientToTab(orch, c, taskId, tab.id)
        broadcastTaskUpdated(orch, clients, taskId)
        return { tab }
      }
      case "chat.tab.close": {
        const taskId = requireString(payload, "taskId")
        const nextActive = await orch.closeTab(taskId, requireString(payload, "tabId"))
        broadcastTaskUpdated(orch, clients, taskId)
        return { nextActive }
      }
      case "chat.tab.activate": {
        const taskId = requireString(payload, "taskId")
        await orch.setActiveTab(taskId, requireString(payload, "tabId"))
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "chat.tab.rename": {
        const taskId = requireString(payload, "taskId")
        await orch.setTabTitle(taskId, requireString(payload, "tabId"), requireString(payload, "title"))
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "chat.sessions": {
        const sessions = await orch.listSessions(requireString(payload, "taskId"))
        return { sessions }
      }
      case "chat.session.open": {
        const taskId = requireString(payload, "taskId")
        const tabId = await orch.openSessionInTab(taskId, requireString(payload, "sessionId"), {
          title: optionalString(payload, "title"),
        })
        // openSessionInTab appends a new tab; subscribe every attached
        // client to its event bus so live deltas reach them.
        for (const c of clients) subscribeClientToTab(orch, c, taskId, tabId)
        broadcastTaskUpdated(orch, clients, taskId)
        return { tabId }
      }
      case "chat.interrupt": {
        await orch.interruptTask(requireString(payload, "taskId"), optionalString(payload, "tabId"))
        return {}
      }
      case "chat.input.pending": {
        return { pending: orch.peekPendingInput(requireString(payload, "taskId")) }
      }
      case "chat.input.respond": {
        await orch.respondToInput(
          requireString(payload, "taskId"),
          requireString(payload, "requestId"),
          requireUserInputResponse(payload.response),
        )
        return {}
      }
      case "pr.request": {
        await orch.requestPR(requireString(payload, "taskId"))
        return {}
      }
      case "chat.history": {
        const taskId = requireString(payload, "taskId")
        const sessionId = optionalString(payload, "sessionId")
        const limit = optionalNumber(payload, "limit") ?? 50
        const before = optionalString(payload, "before")
        const result = await readTaskHistory(orch, taskId, sessionId, limit, before)
        return {
          messages: serializeMessages(result.messages),
          nextBefore: result.nextBefore,
          hasMore: result.hasMore,
        }
      }
      case "chat.send": {
        const taskId = requireString(payload, "taskId")
        const tabId = optionalString(payload, "tabId")
        // Empty / undefined text is a legitimate "continue" / "resume"
        // signal — runTask resumes the existing session without a new
        // user prompt. Earlier code rejected empty text via
        // requireString and the client smuggled a single space (" ") to
        // dodge the check. Now the wire allows undefined.
        const text = optionalString(payload, "text")
        await orch.runTask(taskId, text, tabId)
        const task = orch.getTask(taskId)
        if (task)
          broadcast(clients, {
            type: "event",
            name: "engine.status",
            payload: { taskId, tabId: tabId ?? task.activeTabId, status: "running" },
          })
        return {}
      }
      case "subscribe": {
        const taskIds = normalizeTaskIds(payload.taskIds)
        const tasks =
          taskIds === "all"
            ? orch.listTasks()
            : taskIds.map((id) => orch.getTask(id)).filter((t): t is Task => Boolean(t))
        for (const task of tasks) subscribeClientToTask(orch, client, task)
        return {}
      }
      default:
        throw new Error(`unknown daemon request: ${req.name satisfies never}`)
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

  function drainClientBuffer(orch: Orchestrator, _server: DaemonServer, client: ClientState): void {
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
  const key = `${taskId}:${tabId}`
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
  const prefix = `${taskId}:`
  for (const [key, unsub] of client.subscriptions) {
    if (!key.startsWith(prefix)) continue
    unsub()
    client.subscriptions.delete(key)
  }
}

interface TaskHistoryPage {
  messages: Message[]
  /**
   * Token the client passes back as `before` to fetch the previous
   * page. `null` when this page already includes the oldest message
   * (no further history) — caller stops paging.
   */
  nextBefore: string | null
  hasMore: boolean
}

async function readTaskHistory(
  orch: Orchestrator,
  taskId: string,
  /**
   * Explicit session id requested by the client (per-tab history
   * load). When omitted we fall back to the task's active-tab
   * sessionId — convenient for callers that only know the taskId.
   * Required for tab-switch correctness: Chat hydrates each tab's
   * scrollback independently, so passing the right sessionId is the
   * difference between "every tab shows the active tab's transcript"
   * and "every tab shows its own."
   */
  requestedSessionId: string | undefined,
  limit: number,
  before?: string,
): Promise<TaskHistoryPage> {
  const task = orch.getTask(taskId)
  const sessionId =
    requestedSessionId ?? task?.tabs.find((t) => t.id === task.activeTabId)?.sessionId ?? task?.sessionId
  if (!sessionId) return { messages: [], nextBefore: null, hasMore: false }
  const messages = await orch.readHistory(sessionId)
  const beforeIdx = before ? messages.findIndex((m) => `${m.timestamp}:${m.sessionId}` === before) : -1
  const end = beforeIdx >= 0 ? beforeIdx : messages.length
  const start = Math.max(0, end - limit)
  const page = messages.slice(start, end)
  const hasMore = start > 0
  // Echo the oldest message's token so the client can paginate without
  // having to know the wire format. Falls back to null when there are
  // no messages OR when this page already covers the start.
  const first = page[0]
  const nextBefore = hasMore && first ? `${first.timestamp}:${first.sessionId}` : null
  return { messages: page, nextBefore, hasMore }
}

function writeFrame(client: Pick<ClientState, "socket">, frame: DaemonFrame): void {
  client.socket.write(frameToLine(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  for (const client of clients) writeFrame(client, frame)
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

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`)
  return value
}

function normalizeTaskIds(value: unknown): "all" | string[] {
  if (value === undefined || value === null || value === "all") return "all"
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value
  throw new Error("taskIds must be 'all' or string[]")
}

function requireUserInputResponse(value: unknown): UserInputResponse {
  if (!value || typeof value !== "object") throw new Error("response is required")
  const obj = value as Record<string, unknown>
  if (obj.kind === "approve_plan") {
    if (typeof obj.approve !== "boolean") throw new Error("response.approve must be a boolean")
    return { kind: "approve_plan", approve: obj.approve }
  }
  if (obj.kind === "ask_question") {
    if (!obj.answers || typeof obj.answers !== "object" || Array.isArray(obj.answers)) {
      throw new Error("response.answers must be an object")
    }
    const answers: Record<string, string> = {}
    for (const [key, answer] of Object.entries(obj.answers)) {
      if (typeof answer === "string") answers[key] = answer
    }
    return { kind: "ask_question", answers }
  }
  throw new Error("response.kind must be approve_plan or ask_question")
}
