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
import { type Server, createServer } from "node:net"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { latestTranscriptMtime } from "@/monitor/activity"
import type { Orchestrator } from "@/orchestrator/core"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import type { UpdateInfo } from "@/version"
import { sweepPtyHostSessions } from "../client/pty-process.ts"
import { type ActivityLivenessProbe, DaemonActivityRegistry } from "./activity-registry.ts"
import {
  type ClientState,
  type DaemonClientConnection,
  broadcast,
  drainClientBuffer,
  writeFrame,
} from "./client-connection.ts"
import { ClientWriter } from "./client-writer.ts"
import { startDaemonCollectors } from "./collectors.ts"
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
import { DaemonLifetime } from "./lifetime.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import { type DaemonFrame, normalizeChannelFilter, serializeTask } from "./protocol.ts"
import { type DaemonWebServer, createDirectWebLink, startDaemonWebServer } from "./web-server.ts"

// RPC handler registry + per-request dispatch seam — re-exported so consumers
// (tests, the kobe-web bridge) can reach it via the existing
// `@sma1lboy/kobe-daemon/daemon/server` export without a package.json change.
export {
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  shapeDaemonError,
  type DaemonHandlerContext,
  type DaemonRequestHandler,
} from "./handlers.ts"
export { IssuesStore, defaultIssuesStorePath } from "./issues-store.ts"
export type { DaemonClientConnection } from "./client-connection.ts"

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
  /** Auto-title re-scan interval in ms; `0` disables. Defaults to `DEFAULT_AUTO_TITLE_POLL_MS`. */
  readonly autoTitlePollMs?: number
  /** PR-status (`gh pr view`) poll interval in ms; `0` disables. Defaults to `DEFAULT_PR_STATUS_POLL_MS`. */
  readonly prStatusPollMs?: number
  /** UI-prefs watcher debounce in ms; `0` disables. Defaults to `DEFAULT_UI_PREFS_DEBOUNCE_MS`. */
  readonly uiPrefsDebounceMs?: number
  /** Keybindings watcher debounce in ms; `0` disables. Defaults to `DEFAULT_KEYBINDINGS_DEBOUNCE_MS`. */
  readonly keybindingsDebounceMs?: number
  /** Worktree-changes collector tick in ms; `0` disables. Defaults to `DEFAULT_WORKTREE_CHANGES_TICK_MS`. */
  readonly worktreeChangesTickMs?: number
  /** Transcript-activity collector tick in ms; `0` disables. Defaults to `DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS`. */
  readonly transcriptActivityTickMs?: number
  /** Optional loopback HTTP/SSE browser transport. Omitted in tests unless explicitly requested. */
  readonly webPort?: number
  /** Optional hostname for the browser transport. Defaults to 127.0.0.1. */
  readonly webHost?: string
  /** Optional static web UI directory served by the daemon web transport. */
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

  // Refcounted lazy shutdown + collector gate (KOB): the daemon's lifetime is
  // bound to the number of attached GUIs — a front-end that subscribed with
  // `role: "gui"` (the `kobe` process parked on `tmux attach`, or the kobe-web
  // bridge). The count deliberately EXCLUDES in-tmux helper panes (Tasks/Ops/
  // settings, `role: "pane"`): those subscribe for push channels but persist
  // with the tmux session after the user quits, so counting them kept the
  // daemon alive forever (N ChatTab windows = N Tasks panes, count never hit 0
  // on quit). CLI pokes (hello-only status/stop, `daemon restart`) never
  // subscribe at all. When the LAST gui disconnects we wait a short grace then
  // self-stop, via the normal `stopSoon()` path which NEVER touches tmux (task
  // sessions outlive the daemon; only `kobe reset` / `kobe kill-sessions` tear
  // tmux down). The same object also gates the background collectors on
  // `hasSubscribers()`. The whole policy — refcount, grace timer, stopping flag
  // — lives in DaemonLifetime (lifetime.ts), unit-tested in isolation; the live
  // `clients` set stays its source of truth, so there's no counter to drift.
  const lifetime = new DaemonLifetime({
    clients: function* () {
      yield* clients
      yield* webClients
    },
    idleGraceMs: resolveIdleGraceMs(),
    onIdleStop: () => void stopSoon().catch((err) => logDaemonError("daemon-idle-shutdown", err)),
  })

  // Channel event bus: the single hub the daemon publishes push
  // events to. One sink fans each publish out to subscribed sockets; the
  // bus also caches the last value per channel so a late subscriber gets
  // the current value on connect. `task.snapshot` is channel #1; new
  // channels just call `bus.publish` (see protocol.ts ChannelPayloads).
  const bus = new DaemonEventBus()
  bus.onPublish((event) => {
    broadcast(clients, { type: "event", name: event.channel, payload: event.payload })
  })

  // Liveness probe for the activity watchdog: resolve taskId → worktree +
  // vendor via the orchestrator, then read the engine's newest transcript
  // mtime (the same fs-only history reader auto-title uses — no tmux, no
  // subprocess). A long single turn writes tool output to its transcript
  // even though it emits no hook events between turn-start and Stop, so this
  // mtime is the signal that distinguishes "still working" from a missed
  // Stop. Best-effort: any failure resolves `undefined` ⇒ the watchdog
  // lapses to idle as before, never crashing the daemon.
  const livenessAt: ActivityLivenessProbe = async (taskId) => {
    const task = orch.getTask(taskId)
    if (!task?.worktreePath) return undefined
    return latestTranscriptMtime(task.vendor ?? DEFAULT_TASK_VENDOR, task.worktreePath)
  }
  const activity = new DaemonActivityRegistry(bus, undefined, undefined, livenessAt)

  // Daemon-owned issue tracker (web Issues panel) — a single store keyed by
  // git common-dir, sharing the server's homeDir so sandbox/test homes
  // isolate. Handlers reach it through DaemonHandlerContext.issues.
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

    // Per-connection decoder: holds a partial multibyte UTF-8 sequence (CJK,
    // em-dash, emoji) across TCP chunk boundaries. Decoding each chunk with a
    // bare `toString("utf8")` would emit U+FFFD for a codepoint split between
    // two chunks, silently corrupting task titles / field notes / prompts.
    const decoder = new StringDecoder("utf8")
    socket.on("data", (chunk) => {
      client.buffer += decoder.write(chunk)
      drainClientBuffer(client, (req, c) => void handleRequest(req, c))
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
      // Last GUI gone → start the grace timer toward self-stop. Only a
      // `holdsLifetime` (role "gui") client arms it: a helper pane or a
      // transient CLI poke leaves the gui count unchanged, so neither trips
      // shutdown when it disconnects.
      lifetime.clientDisconnected(client.holdsLifetime)
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
    // Janitor call to the standalone pty host: a task that is archived or
    // gone must not leave a background engine running forever with no owner
    // — covers headless archives (`kobe api`) where no TUI sends pty.kill.
    // Fire-and-forget; never spawns a host, never throws. MUST pass this
    // server's homeDir (like every other path above): a temp-home daemon
    // resolving the ambient default sweeps the REAL pty-host with its own
    // task list — the 2026-07-07/08 "every test run killed my running
    // engines" incident.
    void sweepPtyHostSessions(
      snapshot.filter((t) => !t.archived).map((t) => t.id),
      options.homeDir,
    )
  })

  // Warm the active-task channel with the orchestrator's restored focus
  // (seeded from the persisted `lastActive` record — state/last-active.ts).
  // Without this the channel stays cold until the first `task.setActive`,
  // so every client connecting to a FRESH daemon replays tasks but no
  // focus and falls back to "first task in the list" instead of the last
  // focused one. Publishing null is deliberate — a populated channel with
  // an explicit "no focus" beats a cold one. Optional-chained because test
  // doubles stub a partial Orchestrator.
  bus.publish("active-task", { taskId: orch.activeTaskSignal?.()?.() ?? null })

  // Background collectors/watchers (update poll, auto-title, ui-prefs /
  // keybindings watchers, worktree-changes / transcript-activity / pr-status)
  // — wired in collectors.ts; per-tick work is gated on attached subscribers
  // so a gui-less daemon never polls npm / git / gh for nobody.
  const stopCollectors = startDaemonCollectors(orch, bus, () => lifetime.hasSubscribers(), options)

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
      stopCollectors()
      activity.close()
      // Hosted PTYs are deliberately NOT touched here: they live in the
      // standalone `kobe pty-host` process, so `kobe daemon restart` never
      // ends a running engine session — only `kobe reset` does.
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

  // RPC dispatch seam: every plain request is a registry entry
  // (handlers.ts) — look up → validate → handle — with all daemon state
  // arriving via the per-request context built below. ONE request stays
  // outside the registry: `subscribe` is connection lifecycle, not RPC. It
  // mutates per-socket state (`subscribed`, `holdsLifetime`), drives the
  // gui-refcount idle-grace timer, and writes event frames directly to the
  // socket (channel replay) — none of which the registry's payload→result
  // shape can express — so it lives here next to the machinery it touches.
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
      // role defaults to "pane": a subscriber that omits it is the safe
      // non-lifetime kind, so a future client can't accidentally pin the
      // daemon open. Only a "gui" attach holds the daemon alive.
      const role = payload.role === "gui" ? "gui" : "pane"
      client.holdsLifetime = role === "gui"
      // Per-channel filter (KOB — per-channel subscribe). `null` = no filter
      // → every channel (back-compat: an omitted/garbage `channels` behaves
      // exactly as before). A non-null set restricts both this replay and
      // every later `broadcast` to the named channels, so a narrow consumer
      // (UiPrefsSync wants only ui-prefs + keybindings) stops receiving —
      // and deserializing — the full task.snapshot fan-out it never reads.
      client.channels = normalizeChannelFilter(payload.channels)
      // First-time subscribe with zero prior subscribers → a collector that
      // had paused (gui-less daemon) repopulates on its NEXT tick; nothing
      // to kick synchronously since the interval keeps running.
      const firstSubscriber = !wasSubscribed
      // A GUI (re)attached → cancel any pending lazy-shutdown grace. A
      // pane subscribing must NOT cancel it: panes alone never keep the
      // daemon up, so a pane connecting during the grace window leaves the
      // countdown running.
      if (client.holdsLifetime) lifetime.guiAttached()
      logDaemonInfo(
        "conn",
        `client #${client.id} subscribed as ${role}${client.channels ? ` [${[...client.channels].join(",")}]` : ""} — ${clients.size} client(s), ${lifetime.guiCount()} gui${firstSubscriber ? " (collectors resume)" : ""}`,
      )
      // Replay the current value of every populated channel so a late
      // subscriber hydrates without a separate round trip — generalized
      // from the old single task.snapshot send. Filtered to the
      // client's requested channels (null = all). The bus cache is warm
      // (subscribeTasks' eager fire).
      for (const event of bus.snapshot()) {
        if (client.channels && !client.channels.has(event.channel)) continue
        writeFrame(client, { type: "event", name: event.channel, payload: event.payload })
      }
      // The bus only caches ONE last-value per channel, but `engine-state`
      // is per-task — so additionally replay EVERY task's current non-idle
      // activity to this late subscriber (otherwise it'd only learn the most
      // recently changed task's state). Skip when the client filtered
      // `engine-state` out.
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
    // `pty.*` requests are NOT served here — they belong to the standalone
    // pty host process's socket (`pty-server.ts`). A client that sends one
    // to the daemon gets the registry's "unknown daemon request" error.
    return dispatchDaemonRequest(handlers, req.name, req.payload, handlerContext(client.id))
  }

  async function handleRequest(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<void> {
    try {
      const payload = await dispatch(req, client)
      writeFrame(client, { type: "response", id: req.id, name: req.name, payload })
    } catch (err) {
      // shapeDaemonError (handlers.ts) is the ONE place a thrown error
      // becomes a wire DaemonError — message + Error name, same bytes as
      // the old inline shaping. The parse-error path below deliberately
      // stays bare `{ message }` (it never carried a `name` on the wire).
      writeFrame(client, { type: "response", id: req.id, name: req.name, error: shapeDaemonError(err) })
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
