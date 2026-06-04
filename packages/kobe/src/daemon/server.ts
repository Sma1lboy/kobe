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
import {
  type EngineActivityDetail,
  type EngineActivityKind,
  type TaskActivityState,
  isEngineActivityKind,
  reduceActivity,
} from "../engine/hook-events.ts"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { Task, VendorId } from "../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo, checkLatestVersion } from "../version.ts"
import { DEFAULT_AUTO_TITLE_POLL_MS, startAutoTitlePoller } from "./auto-title-poller.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import { matchTaskByCwd } from "./cwd-task.ts"
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

/**
 * Grace before a subscriber-less daemon self-stops (refcounted lazy
 * shutdown). The window absorbs reconnect races — `manualReconnect()`
 * force-disconnects then re-subscribes, briefly dropping to zero — so a
 * blip doesn't tear the daemon down. Override via `KOBE_DAEMON_IDLE_GRACE_MS`.
 */
const DEFAULT_IDLE_GRACE_MS = 3000

function resolveIdleGraceMs(): number {
  const raw = process.env.KOBE_DAEMON_IDLE_GRACE_MS
  if (raw === undefined) return DEFAULT_IDLE_GRACE_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_GRACE_MS
}

/** How long a non-idle engine-activity state survives with no follow-up event
 *  before lapsing to idle (safety net for a missed Stop/SessionEnd). */
const DEFAULT_ENGINE_STATE_TTL_MS = 10 * 60 * 1000
function resolveEngineStateTtlMs(): number {
  const raw = process.env.KOBE_ENGINE_STATE_TTL_MS
  if (raw === undefined) return DEFAULT_ENGINE_STATE_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_STATE_TTL_MS
}

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
  /** Auto-title re-scan interval in ms; `0` disables. Defaults to {@link DEFAULT_AUTO_TITLE_POLL_MS}. */
  readonly autoTitlePollMs?: number
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
  /**
   * True only when the client subscribed with `role: "gui"` — a real
   * front-end attach. This is the refcount that gates lazy shutdown; an
   * in-tmux helper pane (`role: "pane"`) is `subscribed` (gets channels)
   * but NOT `holdsLifetime`, so closing it never stops the daemon. See
   * {@link SubscribeRole}.
   */
  holdsLifetime: boolean
}

export async function startDaemonServer(orch: Orchestrator, options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const socketPath = options.socketPath ?? defaultDaemonSocketPath(options.homeDir)
  const pidPath = options.pidPath ?? defaultDaemonPidPath(options.homeDir)
  const startedAt = options.startedAt ?? new Date()
  const clients = new Set<ClientState>()
  let nextClientId = 1

  // Refcounted lazy shutdown (KOB): the daemon's lifetime is bound to the
  // number of attached GUIs — a front-end that subscribed with `role: "gui"`
  // (the `kobe` process parked on `tmux attach`, or the outer monitor). The
  // count deliberately EXCLUDES in-tmux helper panes (Tasks/Ops/settings,
  // `role: "pane"`): those subscribe for push channels but persist with the
  // tmux session after the user quits, so counting them kept the daemon alive
  // forever (N ChatTab windows = N Tasks panes, count never hit 0 on quit).
  // CLI pokes (hello-only status/stop, `daemon restart`) never subscribe at
  // all. When the LAST gui disconnects we wait a short grace then self-stop.
  // We arm only on a >0 → 0 transition (never on boot), so a deliberately-
  // foreground `kobe daemon start` or a freshly-respawned `kobe daemon
  // restart` daemon — both gui-less by design — stay up. Shutdown runs the
  // normal `stopSoon()` path, which NEVER touches tmux: task sessions outlive
  // the daemon (only `kobe reset` / `kobe kill-sessions` tear tmux down, via
  // `tmux -L kobe kill-server`).
  const idleGraceMs = resolveIdleGraceMs()
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let stopping = false

  // Attached GUIs — the refcount that gates lazy shutdown. Counts only
  // `holdsLifetime` (role "gui") clients, not every `subscribed` pane.
  function guiCount(): number {
    let n = 0
    for (const c of clients) if (c.holdsLifetime) n++
    return n
  }

  function cancelIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function maybeArmIdleShutdown(): void {
    if (stopping || guiCount() > 0) return
    cancelIdleTimer()
    logDaemonInfo("idle", `last gui gone — arming ${idleGraceMs}ms idle-stop grace`)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (stopping || guiCount() > 0) return
      logDaemonInfo("idle", "grace elapsed with no gui — self-stopping")
      void stopSoon().catch((err) => logDaemonError("daemon-idle-shutdown", err))
    }, idleGraceMs)
    idleTimer.unref?.()
  }

  // Channel event bus (KOB-246): the single hub the daemon publishes push
  // events to. One sink fans each publish out to subscribed sockets; the
  // bus also caches the last value per channel so a late subscriber gets
  // the current value on connect. `task.snapshot` is channel #1; new
  // channels just call `bus.publish` (see protocol.ts ChannelPayloads).
  const bus = new DaemonEventBus()
  bus.onPublish((event) => {
    broadcast(clients, { type: "event", name: event.channel, payload: event.payload })
  })

  // Transient, engine-driven per-task activity (KOB). Folded from normalized
  // hook events (`engine.reportEvent`) and pushed on the `engine-state`
  // channel. In-memory only — never persisted (it's "what is the engine doing
  // RIGHT NOW", not lifecycle). A per-task stale timer lapses a stuck state
  // back to idle if the terminating hook is ever missed (engine crash, etc.).
  interface ActivityEntry {
    state: TaskActivityState
    detail?: EngineActivityDetail
    at: number
    lapse?: ReturnType<typeof setTimeout>
  }
  const activity = new Map<string, ActivityEntry>()
  const ACTIVITY_STALE_MS = resolveEngineStateTtlMs()

  function reportActivity(taskId: string, kind: EngineActivityKind, detail?: EngineActivityDetail): void {
    const prev = activity.get(taskId)
    if (prev?.lapse) clearTimeout(prev.lapse)
    const state = reduceActivity(prev?.state, kind, detail)
    const at = Date.now()
    const entry: ActivityEntry = { state, detail, at }
    // Safety net: a non-idle state that never gets a follow-up event lapses
    // back to idle, so a missed Stop/SessionEnd can't pin a badge forever.
    if (state !== "idle") {
      entry.lapse = setTimeout(() => {
        const cur = activity.get(taskId)
        if (cur && cur.at === at) {
          activity.set(taskId, { state: "idle", at: Date.now() })
          bus.publish("engine-state", { taskId, state: "idle", at: Date.now() })
        }
      }, ACTIVITY_STALE_MS)
      entry.lapse.unref?.()
    }
    activity.set(taskId, entry)
    bus.publish("engine-state", { taskId, state, ...(detail ? { detail } : {}), at })
  }

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
      holdsLifetime: false,
    }
    clients.add(client)

    socket.on("data", (chunk) => {
      client.buffer += chunk.toString("utf8")
      drainClientBuffer(client)
    })
    socket.on("error", () => {})
    socket.on("close", () => {
      clients.delete(client)
      if (client.subscribed) {
        logDaemonInfo(
          "conn",
          `client #${client.id} (${client.holdsLifetime ? "gui" : "pane"}) disconnected — ${clients.size} client(s), ${guiCount()} gui left`,
        )
      }
      // Last GUI gone → start the grace timer toward self-stop. Only a
      // `holdsLifetime` (role "gui") client arms it: a helper pane or a
      // transient CLI poke leaves the gui count unchanged, so neither trips
      // shutdown when it disconnects.
      if (client.holdsLifetime) maybeArmIdleShutdown()
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

  // Live auto-title (KOB): rename still-placeholder tasks from their
  // engine transcript on an interval, so a name appears WHILE attached —
  // the detach-time path in tui/app.tsx / tui/direct.ts only fires on
  // return. The rename broadcasts via the `task.snapshot` channel above,
  // so every attached Tasks pane updates without a detach.
  const autoTitlePollMs = options.autoTitlePollMs ?? DEFAULT_AUTO_TITLE_POLL_MS
  const stopAutoTitlePoller = startAutoTitlePoller(orch, autoTitlePollMs)

  const serverApi: DaemonServer = {
    socketPath,
    pidPath,
    startedAt,
    clients,
    async close() {
      stopping = true
      cancelIdleTimer()
      unsubscribeStore()
      if (updateTimer) clearInterval(updateTimer)
      stopAutoTitlePoller()
      // tmux is intentionally untouched here: closing the daemon never tears
      // down task sessions. Session teardown lives ONLY in `kobe reset` /
      // `kobe kill-sessions` (`tmux -L kobe kill-server`). Keep it that way.
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
    if (stopping) return
    stopping = true
    cancelIdleTimer()
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
          // The daemon's BUILD version (package.json). The protocol range above
          // only catches a breaking wire change; this lets the client detect a
          // stale-build daemon after a patch upgrade (same protocol, old code in
          // memory) and surface a non-fatal "restart the daemon" banner (KOB).
          kobeVersion: CURRENT_VERSION,
          capabilities: [...CHANNEL_NAMES],
          daemonPid: process.pid,
          clientId: client.id,
          tasks: orch.listTasks().map(serializeTask),
        }
      }
      case "daemon.status":
        return {
          daemonPid: process.pid,
          // Build version of the running daemon (package.json) — surfaced in
          // `daemon status` / `kobe doctor` so a stale-build daemon is visible
          // even without a TUI attached (KOB).
          kobeVersion: CURRENT_VERSION,
          uptimeMs: Date.now() - startedAt.getTime(),
          startedAt: startedAt.toISOString(),
          // Attached GUIs (role "gui" front-ends) — the refcount that keeps
          // the daemon alive. Excludes in-tmux helper panes (role "pane") and
          // transient CLI pokes, so this reflects "humans looking at kobe".
          attachedClients: guiCount(),
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
        const gone = activity.get(taskId)
        if (gone?.lapse) clearTimeout(gone.lapse)
        activity.delete(taskId)
        // Publish an explicit idle so every subscriber (incl. late ones that
        // would otherwise replay a stale cached engine-state) clears this
        // task's badge — important if the id is reused by a quick recreate.
        if (gone) bus.publish("engine-state", { taskId, state: "idle", at: Date.now() })
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
          ifExists: optionalString(payload, "ifExists") === "return" ? "return" : "error",
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
      case "engine.reportEvent": {
        // A `kobe hook <verb>` process reporting a NORMALIZED engine activity
        // event (the vendor-specific hook was already translated by the
        // engine's hook adapter). The global hooks carry no task id — they
        // report their `cwd`, which we map to a task by worktree path. Fold it
        // into the task's transient activity state + broadcast on
        // `engine-state`. Unknown kinds are ignored (forward-compat: a newer
        // adapter, older daemon); an unmatched cwd (an unrelated repo, a
        // project with no kobe task) is silently dropped.
        const kind = requireString(payload, "kind")
        if (!isEngineActivityKind(kind)) throw new Error(`unknown engine event kind: ${kind}`)
        // `taskId` (legacy/direct) wins; otherwise resolve from `cwd`.
        const explicitId = optionalString(payload, "taskId")
        const cwd = optionalString(payload, "cwd")
        const taskId = explicitId ?? (cwd ? matchTaskByCwd(orch.listTasks(), cwd) : undefined)
        if (!taskId) return {} // unmatched cwd → drop
        const detail = optionalActivityDetail(payload)
        reportActivity(taskId, kind, detail)
        return {}
      }
      case "subscribe": {
        client.subscribed = true
        // role defaults to "pane": a subscriber that omits it is the safe
        // non-lifetime kind, so a future client can't accidentally pin the
        // daemon open. Only a "gui" attach holds the daemon alive.
        const role = payload.role === "gui" ? "gui" : "pane"
        client.holdsLifetime = role === "gui"
        // A GUI (re)attached → cancel any pending lazy-shutdown grace. A
        // pane subscribing must NOT cancel it: panes alone never keep the
        // daemon up, so a pane connecting during the grace window leaves the
        // countdown running.
        if (client.holdsLifetime) cancelIdleTimer()
        logDaemonInfo(
          "conn",
          `client #${client.id} subscribed as ${role} — ${clients.size} client(s), ${guiCount()} gui`,
        )
        // Replay the current value of every populated channel so a late
        // subscriber hydrates without a separate round trip — generalized
        // from the old single task.snapshot send (KOB-246). `payload.channels`
        // is accepted for forward-compat (a future per-channel filter) but
        // currently ignored: every subscriber gets every channel, exactly
        // as before. The bus cache is warm (subscribeTasks' eager fire).
        for (const event of bus.snapshot()) {
          writeFrame(client, { type: "event", name: event.channel, payload: event.payload })
        }
        // The bus only caches ONE last-value per channel, but `engine-state`
        // is per-task — so additionally replay EVERY task's current non-idle
        // activity to this late subscriber (otherwise it'd only learn the most
        // recently changed task's state).
        for (const [taskId, entry] of activity) {
          if (entry.state === "idle") continue
          writeFrame(client, {
            type: "event",
            name: "engine-state",
            payload: { taskId, state: entry.state, ...(entry.detail ? { detail: entry.detail } : {}), at: entry.at },
          })
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

/** Coerce the optional `detail` of an `engine.reportEvent` payload, dropping
 *  anything malformed (the field is best-effort UI hint, never load-bearing). */
function optionalActivityDetail(payload: Record<string, unknown>): EngineActivityDetail | undefined {
  const raw = payload.detail
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  const out: { failure?: "rate_limit" | "billing" | "other"; waiting?: "permission" | "input"; note?: string } = {}
  if (d.failure === "rate_limit" || d.failure === "billing" || d.failure === "other") out.failure = d.failure
  if (d.waiting === "permission" || d.waiting === "input") out.waiting = d.waiting
  if (typeof d.note === "string") out.note = d.note
  return Object.keys(out).length > 0 ? out : undefined
}
