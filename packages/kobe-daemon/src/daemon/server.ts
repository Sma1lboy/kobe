import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { latestTranscriptMtime } from "@/monitor/activity"
import type { Orchestrator } from "@/orchestrator/core"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import { type UpdateInfo, checkLatestVersion } from "@/version"
import { type ActivityLivenessProbe, DaemonActivityRegistry } from "./activity-registry.ts"
import { DEFAULT_AUTO_TITLE_POLL_MS, startAutoTitlePoller } from "./auto-title-poller.ts"
import { ClientWriter } from "./client-writer.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import { DaemonEventBus } from "./event-bus.ts"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  objectPayload,
  shapeDaemonError,
} from "./handlers.ts"
import { IssuesStore, defaultIssuesStorePath } from "./issues-store.ts"
import {
  DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  defaultKeybindingsPath,
  startKeybindingsWatcher,
} from "./keybindings-watcher.ts"
import { DaemonLifetime } from "./lifetime.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import { DEFAULT_PR_STATUS_POLL_MS, startPrStatusPoller } from "./pr-status-collector.ts"
import { type ChannelName, type DaemonFrame, frameToLine, normalizeChannelFilter, serializeTask } from "./protocol.ts"
import {
  DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
  startTranscriptActivityCollector,
} from "./transcript-activity-collector.ts"
import { DEFAULT_UI_PREFS_DEBOUNCE_MS, defaultUiPrefsStatePath, startUiPrefsWatcher } from "./ui-prefs-watcher.ts"
import { type DaemonWebServer, createDirectWebLink, startDaemonWebServer } from "./web-server.ts"
import { DEFAULT_WORKTREE_CHANGES_TICK_MS, startWorktreeChangesCollector } from "./worktree-changes-collector.ts"

export {
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  shapeDaemonError,
  type DaemonHandlerContext,
  type DaemonRequestHandler,
} from "./handlers.ts"
export { IssuesStore, defaultIssuesStorePath } from "./issues-store.ts"

const DEFAULT_UPDATE_POLL_MS = 6 * 60 * 60 * 1000

const DEFAULT_IDLE_GRACE_MS = 3000

function resolveIdleGraceMs(): number {
  const raw = process.env.KOBE_DAEMON_IDLE_GRACE_MS
  if (raw === undefined) return DEFAULT_IDLE_GRACE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_GRACE_MS
}

export interface DaemonServerOptions {
  readonly socketPath?: string
  readonly pidPath?: string
  readonly homeDir?: string
  readonly startedAt?: Date
  readonly onStop?: () => void | Promise<void>
  readonly checkUpdate?: () => Promise<UpdateInfo | null>
  readonly updatePollMs?: number
  readonly autoTitlePollMs?: number
  readonly prStatusPollMs?: number
  readonly uiPrefsDebounceMs?: number
  readonly keybindingsDebounceMs?: number
  readonly worktreeChangesTickMs?: number
  readonly transcriptActivityTickMs?: number
  readonly webPort?: number
  readonly webHost?: string
  readonly webStaticDir?: string
}

export interface DaemonServer {
  readonly socketPath: string
  readonly pidPath: string
  readonly startedAt: Date
  readonly webPort?: number
  readonly clients: ReadonlySet<DaemonClientConnection>
  close(): Promise<void>
}

export interface DaemonClientConnection {
  readonly id: number
  readonly connectedAt: Date
}

type ClientState = DaemonClientConnection & {
  socket: Socket
  writer: ClientWriter
  buffer: string
  subscribed: boolean
  holdsLifetime: boolean
  channels: ReadonlySet<ChannelName> | null
}

type EventedServer = Server & {
  once(event: "error", listener: (err: Error) => void): void
  removeListener(event: "error", listener: (err: Error) => void): void
}

export async function startDaemonServer(orch: Orchestrator, options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath(options.homeDir)
  const pidPath = options.pidPath ?? defaultDaemonPidPath(options.homeDir)
  const startedAt = options.startedAt ?? new Date()
  const clients = new Set<ClientState>()
  const webClients = new Set<{ subscribed: boolean; holdsLifetime: boolean }>()
  let nextClientId = 1

  const lifetime = new DaemonLifetime({
    clients: function* () {
      yield* clients
      yield* webClients
    },
    idleGraceMs: resolveIdleGraceMs(),
    onIdleStop: () => void stopSoon().catch((err) => logDaemonError("daemon-idle-shutdown", err)),
  })

  const bus = new DaemonEventBus()
  bus.onPublish((event) => {
    broadcast(clients, { type: "event", name: event.channel, payload: event.payload })
  })

  const livenessAt: ActivityLivenessProbe = async (taskId) => {
    const task = orch.getTask(taskId)
    if (!task?.worktreePath) return undefined
    return latestTranscriptMtime(task.vendor ?? DEFAULT_TASK_VENDOR, task.worktreePath)
  }
  const activity = new DaemonActivityRegistry(bus, undefined, undefined, livenessAt)

  const issues = new IssuesStore(defaultIssuesStorePath(options.homeDir))

  await mkdir(dirname(socketPath), { recursive: true })
  await mkdir(dirname(pidPath), { recursive: true })
  await unlink(socketPath).catch(() => {})

  const server: Server = createServer((socket) => {
    const client: ClientState = {
      id: nextClientId++,
      connectedAt: new Date(),
      socket,
      writer: new ClientWriter(socket),
      buffer: "",
      subscribed: false,
      holdsLifetime: false,
      channels: null,
    }
    clients.add(client)

    const decoder = new StringDecoder("utf8")
    socket.on("data", (chunk) => {
      client.buffer += decoder.write(chunk)
      drainClientBuffer(client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      clients.delete(client)
      if (client.subscribed) {
        logDaemonInfo(
          "conn",
          `client #${client.id} (${client.holdsLifetime ? "gui" : "pane"}) disconnected — ${clients.size} client(s), ${lifetime.guiCount()} gui left`,
        )
      }
      lifetime.clientDisconnected(client.holdsLifetime)
    })
  })

  const unsubscribeStore = orch.subscribeTasks((snapshot) => {
    bus.publish("task.snapshot", { tasks: snapshot.map(serializeTask) })
  })

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

  const autoTitlePollMs = options.autoTitlePollMs ?? DEFAULT_AUTO_TITLE_POLL_MS
  const stopAutoTitlePoller = startAutoTitlePoller(orch, autoTitlePollMs, () => lifetime.hasSubscribers())

  const stopUiPrefsWatcher = startUiPrefsWatcher(bus, {
    statePath: defaultUiPrefsStatePath(options.homeDir),
    debounceMs: options.uiPrefsDebounceMs ?? DEFAULT_UI_PREFS_DEBOUNCE_MS,
  })

  const stopKeybindingsWatcher = startKeybindingsWatcher(bus, {
    path: defaultKeybindingsPath(options.homeDir),
    debounceMs: options.keybindingsDebounceMs ?? DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  })

  const stopWorktreeChangesCollector = startWorktreeChangesCollector(
    orch,
    bus,
    options.worktreeChangesTickMs ?? DEFAULT_WORKTREE_CHANGES_TICK_MS,
    () => lifetime.hasSubscribers(),
  )

  const stopTranscriptActivityCollector = startTranscriptActivityCollector(
    orch,
    bus,
    options.transcriptActivityTickMs ?? DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
    () => lifetime.hasSubscribers(),
  )

  const stopPrStatusPoller = startPrStatusPoller(orch, options.prStatusPollMs ?? DEFAULT_PR_STATUS_POLL_MS, () =>
    lifetime.hasSubscribers(),
  )

  let webServer: DaemonWebServer | null = null
  const serverApi: DaemonServer = {
    socketPath,
    pidPath,
    startedAt,
    get webPort() {
      return webServer?.port
    },
    clients,
    async close() {
      lifetime.markStopping()
      unsubscribeStore()
      webServer?.close()
      webServer = null
      if (updateTimer) clearInterval(updateTimer)
      stopAutoTitlePoller()
      stopPrStatusPoller()
      stopUiPrefsWatcher()
      stopKeybindingsWatcher()
      stopWorktreeChangesCollector()
      stopTranscriptActivityCollector()
      activity.close()
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
    const evented = server as EventedServer
    evented.once("error", reject)
    server.listen(socketPath, () => {
      evented.removeListener("error", reject)
      resolve()
    })
  })
  await writeFile(pidPath, `${process.pid}\n`, "utf8")

  async function stopSoon(): Promise<void> {
    if (lifetime.isStopping()) return
    lifetime.markStopping()
    await options.onStop?.()
    setTimeout(() => {
      serverApi.close().catch((err) => logDaemonError("daemon-shutdown", err))
    }, 0).unref()
  }

  const handlers = createDaemonHandlerRegistry()

  function handlerContext(clientId: number): DaemonHandlerContext {
    return {
      orch,
      bus,
      activity,
      issues,
      daemon: {
        startedAt,
        socketPath,
        webPort: webServer?.port,
        pid: process.pid,
        guiCount: () => lifetime.guiCount(),
        stopSoon,
      },
      clientId,
    }
  }

  if (options.webPort !== undefined) {
    const link = createDirectWebLink({
      orch,
      bus,
      activity,
      ctx: handlerContext,
    })
    webServer = await startDaemonWebServer({
      port: options.webPort,
      hostname: options.webHost,
      staticDir: options.webStaticDir,
      link,
      onEvent: (sink) => bus.onPublish(sink),
      onSseOpen: () => {
        const client = { subscribed: true, holdsLifetime: true }
        webClients.add(client)
        lifetime.guiAttached()
        logDaemonInfo(
          "conn",
          `web client subscribed — ${clients.size + webClients.size} client(s), ${lifetime.guiCount()} gui`,
        )
        return () => {
          webClients.delete(client)
          logDaemonInfo(
            "conn",
            `web client disconnected — ${clients.size + webClients.size} client(s), ${lifetime.guiCount()} gui left`,
          )
          lifetime.clientDisconnected(true)
        }
      },
    })
    logDaemonInfo("web", `daemon web transport listening on http://${webServer.hostname}:${webServer.port}`)
  }

  async function dispatch(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<unknown> {
    if (req.name === "subscribe") {
      const payload = objectPayload(req.payload)
      const wasSubscribed = client.subscribed
      client.subscribed = true
      const role = payload.role === "gui" ? "gui" : "pane"
      client.holdsLifetime = role === "gui"
      client.channels = normalizeChannelFilter(payload.channels)
      const firstSubscriber = !wasSubscribed
      if (client.holdsLifetime) lifetime.guiAttached()
      logDaemonInfo(
        "conn",
        `client #${client.id} subscribed as ${role}${client.channels ? ` [${[...client.channels].join(",")}]` : ""} — ${clients.size} client(s), ${lifetime.guiCount()} gui${firstSubscriber ? " (collectors resume)" : ""}`,
      )
      for (const event of bus.snapshot()) {
        if (client.channels && !client.channels.has(event.channel)) continue
        writeFrame(client, { type: "event", name: event.channel, payload: event.payload })
      }
      if (!client.channels || client.channels.has("engine-state")) {
        for (const payload of activity.currentNonIdle()) {
          writeFrame(client, {
            type: "event",
            name: "engine-state",
            payload,
          })
        }
      }
      return {}
    }
    return dispatchDaemonRequest(handlers, req.name, req.payload, handlerContext(client.id))
  }

  async function handleRequest(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<void> {
    try {
      const payload = await dispatch(req, client)
      writeFrame(client, { type: "response", id: req.id, name: req.name, payload })
    } catch (err) {
      writeFrame(client, { type: "response", id: req.id, name: req.name, error: shapeDaemonError(err) })
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

function isCriticalFrame(frame: DaemonFrame): boolean {
  if (frame.type === "event") return frame.name === "daemon.stopping"
  return true
}

function writeFrame(client: Pick<ClientState, "writer">, frame: DaemonFrame): void {
  client.writer.write(frameToLine(frame), isCriticalFrame(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  const channel = frame.type === "event" && frame.name !== "daemon.stopping" ? (frame.name as ChannelName) : null
  const critical = isCriticalFrame(frame)
  let line: string | null = null
  for (const client of clients) {
    if (!client.subscribed && frame.type === "event") continue
    if (channel && client.channels && !client.channels.has(channel)) continue
    line ??= frameToLine(frame)
    client.writer.write(line, critical)
  }
}
