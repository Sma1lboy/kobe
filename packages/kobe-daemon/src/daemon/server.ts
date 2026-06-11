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
import type { Orchestrator } from "@/orchestrator/core"
import { type UpdateInfo, checkLatestVersion } from "@/version"
import { DaemonActivityRegistry } from "./activity-registry.ts"
import { DEFAULT_AUTO_TITLE_POLL_MS, startAutoTitlePoller } from "./auto-title-poller.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import { DaemonEventBus } from "./event-bus.ts"
import { createDaemonHandlerRegistry, dispatchDaemonRequest, objectPayload, shapeDaemonError } from "./handlers.ts"
import {
  DEFAULT_KEYBINDINGS_DEBOUNCE_MS,
  defaultKeybindingsPath,
  startKeybindingsWatcher,
} from "./keybindings-watcher.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import { type ChannelName, type DaemonFrame, frameToLine, normalizeChannelFilter, serializeTask } from "./protocol.ts"
import { DEFAULT_UI_PREFS_DEBOUNCE_MS, defaultUiPrefsStatePath, startUiPrefsWatcher } from "./ui-prefs-watcher.ts"
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
  /** UI-prefs watcher debounce in ms; `0` disables. Defaults to {@link DEFAULT_UI_PREFS_DEBOUNCE_MS}. */
  readonly uiPrefsDebounceMs?: number
  /** Keybindings watcher debounce in ms; `0` disables. Defaults to {@link DEFAULT_KEYBINDINGS_DEBOUNCE_MS}. */
  readonly keybindingsDebounceMs?: number
  /** Worktree-changes collector tick in ms; `0` disables. Defaults to {@link DEFAULT_WORKTREE_CHANGES_TICK_MS}. */
  readonly worktreeChangesTickMs?: number
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
  // The kobe-web bridge subscribes as a regular `gui`, so an open web
  // dashboard holds the daemon alive through this same count.
  function guiCount(): number {
    let n = 0
    for (const c of clients) if (c.holdsLifetime) n++
    return n
  }

  // Any subscribed consumer — gui OR pane (KOB — idle-daemon collector
  // pause). Distinct from `guiCount`: this gates the background COLLECTORS
  // (worktree-changes, auto-title), which exist to feed an attached pane.
  // A gui-less `kobe daemon start` (or a freshly-respawned `daemon restart`)
  // has zero subscribers, so its collectors must NOT run git/tmux walks for
  // nobody — they pause until the first pane subscribes. A pane subscriber
  // is enough: it renders the pushes even though it never holds the daemon
  // alive.
  function hasSubscribers(): boolean {
    for (const c of clients) if (c.subscribed) return true
    return false
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

  const activity = new DaemonActivityRegistry(bus)

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
      channels: null,
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
  // the detach-time path in tui/direct.ts only fires on
  // return. The rename broadcasts via the `task.snapshot` channel above,
  // so every attached Tasks pane updates without a detach.
  const autoTitlePollMs = options.autoTitlePollMs ?? DEFAULT_AUTO_TITLE_POLL_MS
  const stopAutoTitlePoller = startAutoTitlePoller(orch, autoTitlePollMs, hasSubscribers)

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
    hasSubscribers,
  )

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
      stopUiPrefsWatcher()
      stopKeybindingsWatcher()
      stopWorktreeChangesCollector()
      activity.close()
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
    if (stopping) return
    stopping = true
    cancelIdleTimer()
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
      if (client.holdsLifetime) cancelIdleTimer()
      logDaemonInfo(
        "conn",
        `client #${client.id} subscribed as ${role}${client.channels ? ` [${[...client.channels].join(",")}]` : ""} — ${clients.size} client(s), ${guiCount()} gui${firstSubscriber ? " (collectors resume)" : ""}`,
      )
      // Replay the current value of every populated channel so a late
      // subscriber hydrates without a separate round trip — generalized
      // from the old single task.snapshot send (KOB-246). Filtered to the
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
    return dispatchDaemonRequest(handlers, req.name, req.payload, {
      orch,
      bus,
      activity,
      daemon: { startedAt, socketPath, pid: process.pid, guiCount, stopSoon },
      clientId: client.id,
    })
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

function writeFrame(client: Pick<ClientState, "socket">, frame: DaemonFrame): void {
  client.socket.write(frameToLine(frame))
}

function broadcast(clients: ReadonlySet<ClientState>, frame: DaemonFrame): void {
  // Serialize ONCE per publish, not once per subscriber: a task.snapshot
  // frame is ~8.5KB at 20 tasks, so N subscribed panes used to cost N
  // identical JSON.stringify passes per task mutation. The wire bytes are
  // unchanged — every subscriber receives the exact same line.
  //
  // Per-channel filter (KOB — per-channel subscribe): a channel event is
  // skipped for a client whose `channels` filter excludes it, so a narrow
  // consumer no longer receives (nor parses) fan-out it never reads. The
  // `daemon.stopping` lifecycle frame is NOT a channel — it bypasses the
  // filter so every subscriber learns the daemon is going down.
  const channel = frame.type === "event" && frame.name !== "daemon.stopping" ? (frame.name as ChannelName) : null
  let line: string | null = null
  for (const client of clients) {
    if (!client.subscribed && frame.type === "event") continue
    if (channel && client.channels && !client.channels.has(channel)) continue
    line ??= frameToLine(frame)
    client.socket.write(line)
  }
}
