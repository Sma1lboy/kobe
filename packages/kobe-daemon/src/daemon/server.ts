/**
 * kobe daemon server: the single writer for the task index, plus the
 * push-channel bus every attached TUI/pane/web client subscribes to. RPC
 * surface: hello / daemon.status / daemon.stop + handlers.ts + subscribe.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { type Server, createServer } from "node:net"
import { dirname } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { probeDaemonSocket } from "../client/daemon-process.ts"
import { ptyHostHasLiveSessions, sweepPtyHostSessions } from "../client/pty-process.ts"
import { maybeStartPluginHost } from "../plugins/runtime.ts"
import { readActivityLiveness } from "./activity-liveness.ts"
import { type ActivityLivenessProbe, DaemonActivityRegistry } from "./activity-registry.ts"
import { AgentTurnsStore, defaultAgentTurnsPath } from "./agent-turns-store.ts"
import { AttentionInboxStore, defaultAttentionInboxPath } from "./attention-inbox.ts"
import { initAutomationsStore } from "./automation-wiring.ts"
import { type ClientState, broadcast, drainClientBuffer, writeFrame } from "./client-connection.ts"
import { ClientWriter } from "./client-writer.ts"
import { startDaemonCollectors } from "./collectors.ts"
import type { DaemonOrchestrator } from "./contracts.ts"
import { logDaemonError, logDaemonInfo } from "./crash-log.ts"
import { EngineEventLog } from "./engine-events-log.ts"
import { DaemonEventBus } from "./event-bus.ts"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  objectPayload,
  shapeDaemonError,
} from "./handlers.ts"
import { IssuesStore, defaultIssuesStorePath } from "./issues-store.ts"
import { DaemonLifetime, FIRST_GUI_GRACE_MS, resolveIdleGraceMs } from "./lifetime.ts"
import { NotesStore, defaultNotesStorePath } from "./notes-store.ts"
import { defaultDaemonPidPath, defaultDaemonSocketPath, resolveDaemonHomeDir } from "./paths.ts"
import { PromptBroker } from "./prompt-broker.ts"
import { type DaemonFrame, normalizeChannelFilter, serializeTask } from "./protocol.ts"
import { PtyLiveHold } from "./pty-live-hold.ts"
import { QuotaUsageCache } from "./quota-usage-cache.ts"
import type { DaemonServer, DaemonServerOptions } from "./server-options.ts"
import { createSocketOwnershipGuard, listenOnUnixSocket } from "./socket-guard.ts"
import { handleSubscribe } from "./subscribe.ts"
import { TaskDeletionRunner } from "./task-deletion-runner.ts"
import { type DaemonWebServer, createDirectWebLink, startDaemonWebServer } from "./web-server.ts"
import { WorkItemCache } from "./work-items.ts"

// RPC handler registry + per-request dispatch seam — re-exported so consumers
// (tests, kobe-web bridge) keep the existing `daemon/server` import path.
export {
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
  shapeDaemonError,
  type DaemonHandlerContext,
  type DaemonRequestHandler,
} from "./handlers.ts"
export { readPidFile } from "./socket-guard.ts"
export { IssuesStore, defaultIssuesStorePath } from "./issues-store.ts"
export { NotesStore, defaultNotesStorePath } from "./notes-store.ts"
export type { DaemonClientConnection } from "./client-connection.ts"
export type { DaemonServer, DaemonServerOptions } from "./server-options.ts"

export async function startDaemonServer(orch: DaemonOrchestrator, options: DaemonServerOptions): Promise<DaemonServer> {
  const runtime = options.runtime
  const socketPath = options.socketPath ?? defaultDaemonSocketPath(options.homeDir)
  const pidPath = options.pidPath ?? defaultDaemonPidPath(options.homeDir)
  // The state root this daemon actually serves. Reported by `hello` so a
  // client can refuse a daemon that belongs to a DIFFERENT home before it
  // renders that daemon's (empty) task list as its own — see
  // `isForeignDaemonHome` in protocol.ts.
  const homeDir = resolveDaemonHomeDir(options.homeDir)
  const startedAt = options.startedAt ?? new Date()
  // Never steal a live daemon's socket: an unconditional pre-bind unlink let
  // an autospawned daemon usurp the path while the incumbent kept serving its
  // attached clients — hooks and TUI split across two daemons, activity
  // badges gone (prod 2026-08-10). Probed FIRST so a refused boot constructs
  // nothing. A dead ("absent") or hung ("wedged", connects but won't answer
  // hello — replaceable, same recoverability the unconditional unlink
  // provided) socket may still be cleared below.
  if ((await probeDaemonSocket(socketPath)) === "alive") {
    throw new Error(`rove daemon: another daemon is already serving ${socketPath} — refusing to replace it`)
  }
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
    // Autospawned daemons (connectOrStartDaemon's spawn stamps the env
    // flag) reap themselves if no gui EVER attaches — the zombie hole.
    ...(process.env.KOBE_DAEMON_AUTOSPAWNED === "1" ? { firstGuiGraceMs: FIRST_GUI_GRACE_MS } : {}),
    // Non-gui reasons to stay alive, both read lazily (constructed below,
    // polled at shutdown-decision time): an enabled schedule — one that only
    // fires while someone is watching is not a schedule — and a live hosted
    // PTY session (see pty-live-hold.ts: idle-stopping while engines run
    // drops their hook events and blanks the activity dots).
    keepAlive: () => automations.hasEnabled() || ptyHold.isHeld(),
    onIdleStop: () => void stopSoon().catch((err) => logDaemonError("daemon-idle-shutdown", err)),
  })
  const ptyHold = new PtyLiveHold({
    probe: () => ptyHostHasLiveSessions(options.homeDir),
    onRelease: () => lifetime.reevaluateIdle(),
  })
  ptyHold.start()

  // Channel event bus: the single hub the daemon publishes push
  // events to. One sink fans each publish out to subscribed sockets; the
  // bus also caches the last value per channel so a late subscriber gets
  // the current value on connect. `task.snapshot` is channel #1; new
  // channels just call `bus.publish` (see protocol.ts ChannelPayloads).
  const bus = new DaemonEventBus()
  bus.onPublish((event) => {
    broadcast(clients, { type: "event", name: event.channel, payload: event.payload })
  })

  // Liveness probe for the activity lapse watchdog — see activity-liveness.ts
  // for why it reads a completion marker and not just the transcript mtime.
  const livenessAt: ActivityLivenessProbe = (taskId, vendor, transcriptPath) =>
    readActivityLiveness(orch, runtime, taskId, vendor, transcriptPath)
  const activity = new DaemonActivityRegistry(bus, undefined, undefined, livenessAt)
  const inbox = new AttentionInboxStore(defaultAttentionInboxPath(options.homeDir), bus)
  await inbox.init().catch((err) => logDaemonError("attention-inbox-init", err))
  // Durable per-turn telemetry (issue #32) — written by the `turn-complete`
  // hook ingest, read by `agentTurn.list`. Same homeDir isolation as the
  // other daemon-owned stores so a sandbox home never writes to the real one.
  const agentTurns = new AgentTurnsStore(defaultAgentTurnsPath(options.homeDir))
  await agentTurns.init().catch((err) => logDaemonError("agent-turns-init", err))
  const clearTaskState = (taskId: string) =>
    inbox
      .deleteTaskBestEffort(taskId)
      .finally(() => agentTurns.deleteTask(taskId).catch((err) => logDaemonError("agent-turns-delete", err)))
      .finally(() => activity.clearTask(taskId))
  const deletions = new TaskDeletionRunner(orch, runtime, clearTaskState)
  // Daemon-owned issue tracker (web Issues panel) — a single store keyed by
  // git common-dir, sharing the server's homeDir so sandbox/test homes
  // isolate. Handlers reach it through DaemonHandlerContext.issues.
  const issues = new IssuesStore(defaultIssuesStorePath(options.homeDir))
  // Durable field notes (docs/design/dispatcher.md) — same key convention and
  // homeDir isolation as the issue store. Written by `note.file`, read back at
  // worktree launch so a fresh session starts with the repo's known gotchas.
  const notes = new NotesStore(defaultNotesStorePath(options.homeDir))
  // Daemon-owned scheduled automations. The sweep that fires them is started
  // with the other collectors; this only loads the persisted schedules.
  const automations = await initAutomationsStore(options.homeDir)
  // Read-only external tracker view; in-memory only (see work-items.ts).
  const workItems = new WorkItemCache()
  // Sole caller of the engine quota probes — owns the fetch cadence (the
  // vendor usage APIs are themselves rate-limited). Shared by the usage
  // poller (collectors) and the rate-limit resume scheduler (handlers).
  const quotaUsage = new QuotaUsageCache(runtime, bus)
  // Per-task recent engine events (the TUI event feed / task.recentEvents).
  const engineEvents = new EngineEventLog()

  await mkdir(dirname(socketPath), { recursive: true })
  await mkdir(dirname(pidPath), { recursive: true })
  // Stale leftover only — a live owner was refused at the top of this boot.
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
      // shutdown when it disconnects. Refresh the pty hold first so the
      // grace recheck reads live-session truth, not a poll-stale cache.
      if (client.holdsLifetime) void ptyHold.probeSoon()
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
  deletions.resume(orch.listTasks())

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
  const stopCollectors = startDaemonCollectors(
    orch,
    runtime,
    bus,
    () => lifetime.hasSubscribers(),
    options,
    quotaUsage,
    {
      store: automations,
      // `selfLink` is defined below (it closes over handlerContext, which closes
      // over half this function); the sweep only reads it on a tick, long after
      // construction settles.
      link: () => selfLink,
    },
    activity,
  )

  // Plugin runtime: startup hooks + channel-derived event hooks (plugins/runtime.ts).
  const pluginHost = maybeStartPluginHost(bus, options, socketPath, (line) => logDaemonInfo("plugin-host", line))

  // Pending host-dialog prompts (`ui.prompt` ↔ `ui.promptReply`).
  const prompts = new PromptBroker()

  let webServer: DaemonWebServer | null = null
  // Why the web transport isn't listening (port taken, bind failed). Surfaced
  // via daemon.status so `kobe daemon status` reports the real reason instead
  // of the TUI's misleading "daemon did not start".
  let webError: string | null = null

  // Ownership watch (issue #10, rationale in socket-guard.ts): a daemon whose
  // socket path was taken over is unreachable for every NEW connection and
  // must not linger as a split-brain island — stop, so the attached clients'
  // reconnect loops migrate them to the new owner.
  const sockGuard = createSocketOwnershipGuard({
    socketPath,
    pidPath,
    ...(options.socketWatchMs !== undefined ? { watchMs: options.socketWatchMs } : {}),
    onLost: () => {
      logDaemonInfo("sock", "socket path was taken over or removed — stopping so clients reconnect to the new owner")
      void stopSoon().catch((err) => logDaemonError("daemon-socket-lost-shutdown", err))
    },
  })
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
      ptyHold.stop()
      pluginHost?.stop()
      prompts.clear()
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
      // Ownership-aware teardown: a superseded daemon must neither close the
      // listener nor unlink files another daemon owns — see socket-guard.ts.
      await sockGuard.release(server)
    },
  }

  await listenOnUnixSocket(server, socketPath)
  await writeFile(pidPath, `${process.pid}\n`, "utf8")
  await sockGuard.arm()

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
      runtime,
      bus,
      activity,
      inbox,
      agentTurns,
      deletions,
      issues,
      notes,
      automations,
      workItems,
      selfLink,
      quotaUsage,
      engineEvents,
      ...(pluginHost ? { plugins: pluginHost } : {}),
      prompts,
      daemon: {
        startedAt,
        socketPath,
        homeDir,
        webPort: webServer?.port,
        webError,
        pid: process.pid,
        guiCount: () => lifetime.guiCount(),
        stopSoon,
        reevaluateIdle: () => lifetime.reevaluateIdle(),
      },
      clientId,
    }
  }

  // In-process RPC client over the daemon's OWN handler registry — no socket,
  // no web transport. Built unconditionally: the automation runner needs it to
  // launch engine sessions whether or not `--web-port` was passed. The web
  // server reuses the same object when it is enabled.
  const selfLink = createDirectWebLink({ orch, bus, activity, ctx: handlerContext })

  if (options.webPort !== undefined) {
    // The web transport is a SECONDARY surface — a bind failure (port taken by
    // a stray `vite preview`, another kobe daemon, whatever) must NEVER take
    // the daemon down. Degrade to socket-only, record the reason for status,
    // and keep serving every attached TUI/pane over the unix socket.
    try {
      webServer = await startDaemonWebServer({
        runtime,
        port: options.webPort,
        hostname: options.webHost,
        staticDir: options.webStaticDir,
        link: selfLink,
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
            void ptyHold.probeSoon()
            lifetime.clientDisconnected(true)
          }
        },
      })
      logDaemonInfo("web", `daemon web transport listening on http://${webServer.hostname}:${webServer.port}`)
    } catch (err) {
      webServer = null
      webError = err instanceof Error ? err.message : String(err)
      logDaemonError("web", err)
      logDaemonInfo("web", "daemon running socket-only — web transport disabled (see error above)")
    }
  }

  async function dispatch(req: Extract<DaemonFrame, { type: "request" }>, client: ClientState): Promise<unknown> {
    if (req.name === "subscribe") {
      const hadSubscribers = lifetime.hasSubscribers()
      const result = handleSubscribe(client, objectPayload(req.payload), {
        bus,
        activity,
        lifetime,
        clientCount: () => clients.size,
        writeEvent: (target, name, payload) => writeFrame(target as ClientState, { type: "event", name, payload }),
      })
      if (!hadSubscribers && lifetime.hasSubscribers()) {
        // The poller's startup tick ran before this client could subscribe;
        // wake it now instead of leaving a cold footer empty for 60 seconds.
        for (const vendor of runtime.vendorsWithQuotaProbe()) void quotaUsage.refreshIfDue(vendor)
      }
      return result
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
