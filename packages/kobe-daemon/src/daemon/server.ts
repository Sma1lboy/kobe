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
import { StringDecoder } from "node:string_decoder"
import { latestTranscriptMtime } from "@/monitor/activity"
import type { Orchestrator } from "@/orchestrator/core"
import { DEFAULT_TASK_VENDOR } from "@/types/task"
import { type UpdateInfo, checkLatestVersion } from "@/version"
import { sweepPtyHostSessions } from "../client/pty-process.ts"
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
  /** PR-status (`gh pr view`) poll interval in ms; `0` disables. Defaults to {@link DEFAULT_PR_STATUS_POLL_MS}. */
  readonly prStatusPollMs?: number
  /** UI-prefs watcher debounce in ms; `0` disables. Defaults to {@link DEFAULT_UI_PREFS_DEBOUNCE_MS}. */
  readonly uiPrefsDebounceMs?: number
  /** Keybindings watcher debounce in ms; `0` disables. Defaults to {@link DEFAULT_KEYBINDINGS_DEBOUNCE_MS}. */
  readonly keybindingsDebounceMs?: number
  /** Worktree-changes collector tick in ms; `0` disables. Defaults to {@link DEFAULT_WORKTREE_CHANGES_TICK_MS}. */
  readonly worktreeChangesTickMs?: number
  /** Transcript-activity collector tick in ms; `0` disables. Defaults to {@link DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS}. */
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

export interface DaemonClientConnection {
  readonly id: number
  readonly connectedAt: Date
}

type ClientState = DaemonClientConnection & {
  socket: Socket
  /**
   * Backpressure-aware writer for this socket (fix E). Every server→client
   * frame goes through it so a slow/stalled client buffers in a bounded
   * per-client queue (oldest droppable frames shed past the high-water mark)
   * instead of letting Node queue unbounded heap on the long-lived daemon.
   * Lifecycle/response frames are never dropped. See {@link ClientWriter}.
   */
  writer: ClientWriter
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
  /**
   * Per-channel subscribe filter (KOB — per-channel subscribe). `null` =
   * "no filter, deliver every channel" (the historical behavior — what a
   * subscriber that omits `channels` gets). A non-null set restricts both
   * the connect-time replay AND every later `broadcast` to the named
   * channels, so a narrow consumer (e.g. host-boot's UiPrefsSync, which
   * only wants `ui-prefs` + `keybindings`) no longer receives — and
   * deserializes — the full `task.snapshot` fan-out it never reads. The
   * `daemon.stopping` lifecycle frame is NOT a channel and bypasses this
   * filter (every subscriber must learn the daemon is going down).
   */
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
    // Fire-and-forget; never spawns a host, never throws.
    void sweepPtyHostSessions(snapshot.filter((t) => !t.archived).map((t) => t.id))
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
  // the detach-time path in tui/direct.ts only fires on
  // return. The rename broadcasts via the `task.snapshot` channel above,
  // so every attached Tasks pane updates without a detach.
  const autoTitlePollMs = options.autoTitlePollMs ?? DEFAULT_AUTO_TITLE_POLL_MS
  const stopAutoTitlePoller = startAutoTitlePoller(orch, autoTitlePollMs, () => lifetime.hasSubscribers())

  // Live visual prefs (KOB — cross-session theme propagation): watch
  // `state.json` for the theme / transparent / focus-accent keys and
  // publish them on the `ui-prefs` channel, so every pane in EVERY task
  // session re-applies a Settings appearance change live instead of
  // keeping its boot-time read forever. The state path follows the same
  // homeDir the server was started with, so sandbox/test homes isolate.
  const stopUiPrefsWatcher = startUiPrefsWatcher(bus, {
    statePath: defaultUiPrefsStatePath(options.homeDir),
    debounceMs: options.uiPrefsDebounceMs ?? DEFAULT_UI_PREFS_DEBOUNCE_MS,
  })

  // Live keybindings (KOB — cross-session keybinding propagation): watch
  // `~/.kobe/settings/keybindings.yaml` and ping the `keybindings` channel
  // on change, so every pane re-reads + re-applies the file onto its
  // KobeKeymap live instead of needing a session rebuild. Same homeDir
  // isolation as the ui-prefs watcher above.
  const stopKeybindingsWatcher = startKeybindingsWatcher(bus, {
    path: defaultKeybindingsPath(options.homeDir),
    debounceMs: options.keybindingsDebounceMs ?? DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  })

  // Single worktree-changes collector (issue #6): the daemon runs the
  // guarded `git status` polls for every non-archived local worktree and
  // publishes the full counts map on the `worktree.changes` channel, so
  // panes render pushes instead of each spawning their own per-row git
  // polls. Panes detect the channel via `hello.capabilities` and keep
  // their local poller only as the no-daemon / old-daemon fallback.
  const stopWorktreeChangesCollector = startWorktreeChangesCollector(
    orch,
    bus,
    options.worktreeChangesTickMs ?? DEFAULT_WORKTREE_CHANGES_TICK_MS,
    () => lifetime.hasSubscribers(),
  )

  // Single transcript-activity collector (perf — deduplicate per-Ops-pane
  // polling): the daemon runs the guarded FILESYSTEM probes (newest
  // transcript mtime + the engine-owned completion marker) for every
  // non-archived local worktree and publishes the full map on the
  // `transcript.activity` channel, so Ops panes render pushes instead of
  // each stat'ing + parsing the transcript store on their own timers. The
  // per-window tmux capture-pane quiescence check + @kobe_tab_state write
  // stay in-process (the daemon never touches tmux). Panes detect the
  // channel via `hello.capabilities` and keep their local probes only as
  // the no-daemon / old-daemon fallback.
  const stopTranscriptActivityCollector = startTranscriptActivityCollector(
    orch,
    bus,
    options.transcriptActivityTickMs ?? DEFAULT_TRANSCRIPT_ACTIVITY_TICK_MS,
    () => lifetime.hasSubscribers(),
  )

  // PR-status poller: shells `gh pr view` per task with a real branch
  // and writes the result onto Task.prStatus, which rides the same task push as
  // every other field. Gated on subscribers so a gui-less daemon never hits the
  // network for nobody.
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

/**
 * Critical frames are never dropped under backpressure (fix E): the
 * `daemon.stopping` lifecycle signal (every client must learn the daemon is
 * going down) and every RPC `response` (dropping one would hang the client's
 * pending request). Channel `event` frames are droppable — the bus
 * last-value-coalesces them, so a dropped intermediate is superseded by the
 * next publish.
 */
function isCriticalFrame(frame: DaemonFrame): boolean {
  if (frame.type === "event") return frame.name === "daemon.stopping"
  return true
}

function writeFrame(client: Pick<ClientState, "writer">, frame: DaemonFrame): void {
  client.writer.write(frameToLine(frame), isCriticalFrame(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  // Serialize ONCE per publish, not once per subscriber: a task.snapshot
  // frame is ~8.5KB at 20 tasks, so N subscribers would otherwise cost N
  // identical JSON.stringify passes per task mutation. The wire bytes are
  // unchanged — every subscriber receives the exact same line.
  //
  // Per-channel filter (KOB — per-channel subscribe): a channel event is
  // skipped for a client whose `channels` filter excludes it, so a narrow
  // consumer no longer receives (nor parses) fan-out it never reads. The
  // `daemon.stopping` lifecycle frame is NOT a channel — it bypasses the
  // filter so every subscriber learns the daemon is going down.
  const channel = frame.type === "event" && frame.name !== "daemon.stopping" ? (frame.name as ChannelName) : null
  // Backpressure (fix E): each client's writer obeys its own socket's drain
  // signal and buffers in a bounded per-client queue, so one slow client can
  // neither stall the fan-out for healthy clients nor grow the daemon heap
  // unbounded. Critical-ness is identical for all clients, so compute it once.
  const critical = isCriticalFrame(frame)
  let line: string | null = null
  for (const client of clients) {
    if (!client.subscribed && frame.type === "event") continue
    if (channel && client.channels && !client.channels.has(channel)) continue
    line ??= frameToLine(frame)
    client.writer.write(line, critical)
  }
}
