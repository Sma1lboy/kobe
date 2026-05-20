import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { type Server, type Socket, createServer } from "node:net"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { findClaudeBinary } from "../engine/claude-code-local/binary.ts"
import { encodeCwd } from "../engine/claude-code-local/history.ts"
import type { Orchestrator } from "../orchestrator/core.ts"
import type { SessionUsageMetrics } from "../session/usage-metrics.ts"
import { resolveRepoRoot } from "../state/repos.ts"
import { buildClaudeShellCommand, sniffNewSessionId } from "../tmux/claude-spawn.ts"
import { type TmuxControlClient, spawnControlClient } from "../tmux/control-client.ts"
import { createPaneStash } from "../tmux/pane-stash.ts"
import type { Message, ModelEffortLevel, OrchestratorEvent, UserInputResponse } from "../types/engine.ts"
import type { Task, VendorId } from "../types/task.ts"
import { type ActiveState, createActiveState } from "./active-state.ts"
import { logDaemonError } from "./crash-log.ts"
import { PaneStashAdapter } from "./pane-stash-adapter.ts"
/**
 * Minimal contract the daemon needs from a pane-stash adapter. The
 * production wiring (sprint-6) plugs in a real `PaneStashAdapter`;
 * tests pass a recording spy. Kept as an interface so neither side has
 * to import the implementation just to satisfy a type check.
 */
export interface DaemonPaneStashAdapter {
  ensureSpawnedForTab(taskId: string, tabId: string, command: string): Promise<string>
  swapToChat(taskId: string, tabId: string): Promise<void>
  killForTab(taskId: string, tabId: string): Promise<void>
}
import { defaultDaemonPidPath, defaultDaemonSocketPath } from "./paths.ts"
import { type PlanUsagePoller, createPlanUsagePoller } from "./plan-usage-poller.ts"
import {
  DAEMON_PROTOCOL_VERSION,
  frameToLine,
  normalizeEventForWire,
  serializeMessages,
  serializeTask,
} from "./protocol.ts"
import type { DaemonFrame, SerializedHistoryPage } from "./protocol.ts"
import { type RcBridge, createRcBridge } from "./rc-bridge.ts"

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
  /**
   * Override the daemon-wide active-task state. Tests inject a pre-seeded
   * instance; production lets the daemon create a fresh `createActiveState()`.
   */
  readonly activeState?: ActiveState
  /**
   * Optional tmux pane-stash adapter (sprint-5). When present, the
   * rpc.* verbs that mutate (task, tab) state also drive the visible
   * chat-pane swap: `rpc.newTab` ensures a stash pane and swaps to it,
   * `rpc.closeTab` kills the stash pane (after first swapping away if
   * it was displayed), `rpc.switchTab` / `rpc.switchTask` /
   * `rpc.nextTask` / `rpc.prevTask` swap to the resolved tab.
   *
   * When omitted (current production path — bootstrap doesn't construct
   * one yet), all swap/spawn/kill calls are skipped silently. Sprint-6
   * wires the bootstrap → daemon `tmux.attach` rpc that supplies a real
   * adapter.
   */
  readonly paneStashAdapter?: DaemonPaneStashAdapter
  /**
   * Resolves the shell command to run for a `(task, tab)` claude pane.
   * Only consulted when `paneStashAdapter` is present. Defaults to a
   * placeholder that prints + sleeps — sprint-6 swaps in the real
   * `buildClaudeShellCommand` + session-id sniff plumbing.
   */
  readonly resolveChatPaneCommand?: (taskId: string, tabId: string) => string | null
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

  // Daemon-wide foregrounded task. Drives the tmux pane subprocesses
  // (which render whatever task the user currently has focused) and the
  // M-n / M-p task-cycling chords. Broadcast on every change so each
  // pane re-renders without polling.
  const activeState = options.activeState ?? createActiveState()
  activeState.onChange((activeTaskId) =>
    broadcast(clients, { type: "event", name: "active.changed", payload: { activeTaskId } }),
  )

  // Optional tmux pane-stash adapter — installed either via
  // `options.paneStashAdapter` (tests + back-compat) or replaced at
  // runtime by the `tmux.attach` rpc verb (sprint-6 production path).
  // Mutable so a daemon that booted before bootstrap finished can still
  // pick up the adapter when `tmux.attach` arrives.
  let paneStashAdapter: DaemonPaneStashAdapter | null = options.paneStashAdapter ?? null
  let resolvePaneCommand: ((taskId: string, tabId: string) => string | null) | null =
    options.resolveChatPaneCommand ?? null
  // Held so `serverApi.close()` can detach the tmux subprocess cleanly
  // on daemon shutdown. Null until `tmux.attach` runs.
  let tmuxClient: TmuxControlClient | null = null

  /**
   * Best-effort ensure-spawn + swap for a (task, tab) pair. After a
   * successful spawn for a tab that has no persisted sessionId, sniff
   * the new `<sid>.jsonl` Claude Code writes to
   * `~/.claude/projects/<encoded-cwd>/` and persist it on the tab so
   * subsequent ensures resume the same session (`claude --resume <sid>`).
   *
   * Best-effort: tmux failures are logged but never bubble up to the
   * rpc caller — rpc verbs should still mutate orchestrator state even
   * if the visible swap drifts. Sprint-6 used a separate `safeSwap`
   * path that skipped the ensure-and-spawn machinery; sprint-7 routes
   * every active-state mutation through this so a never-spawned
   * sibling tab gets spawned + sniffed on demand (KOB-219).
   */
  function safeEnsureAndSwap(taskId: string, tabId: string): void {
    const adapter = paneStashAdapter
    if (!adapter) return
    const cmd = resolvePaneCommand?.(taskId, tabId)
    if (!cmd) return
    const task = orch.getTask(taskId)
    const tab = task?.tabs.find((t) => t.id === tabId)
    const cwd = task?.worktreePath ?? null
    const shouldSniff = Boolean(cwd) && !tab?.sessionId
    const projectDir = cwd ? `${homedir()}/.claude/projects/${encodeCwd(cwd)}` : null
    const beforeSnapshot = shouldSniff && projectDir ? safeListDir(projectDir) : Promise.resolve<string[]>([])
    void (async () => {
      const before = new Set(await beforeSnapshot)
      await adapter.ensureSpawnedForTab(taskId, tabId, cmd)
      await adapter.swapToChat(taskId, tabId)
      if (!shouldSniff || !cwd) return
      const sid = await pollForSessionId(cwd, before)
      if (sid) {
        try {
          await orch.setTabSessionId(taskId, tabId, sid)
          broadcastTaskUpdated(orch, clients, taskId)
        } catch (err) {
          logDaemonError("pane-stash-session-persist", err)
        }
      } else {
        logDaemonError(
          "pane-stash-session-sniff",
          new Error(`sniffNewSessionId timed out for task ${taskId} tab ${tabId} cwd ${cwd}`),
        )
      }
    })().catch((err) => logDaemonError("pane-stash-spawn", err))
  }

  /** Best-effort kill of a stash pane after a tab close. */
  function safeKill(taskId: string, tabId: string): void {
    const adapter = paneStashAdapter
    if (!adapter) return
    void adapter.killForTab(taskId, tabId).catch((err) => logDaemonError("pane-stash-kill", err))
  }

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
      // Detach the tmux control client (sprint-6) before the socket so
      // the orphaned tmux subprocess gets a graceful `detach-client`
      // rather than a TCP-style RST on parent exit. Failures are logged
      // but never block shutdown. The `tmuxClient = null` happens
      // BEFORE the close so the on("close") listener doesn't mistake
      // this graceful shutdown for an unexpected crash.
      if (tmuxClient) {
        const client = tmuxClient
        tmuxClient = null
        try {
          await client.close()
        } catch (err) {
          logDaemonError("tmux-client-close", err)
        }
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
      serverApi.close().catch((err) => logDaemonError("daemon-shutdown", err))
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
        // Snapshot per-tab run state so a reconnecting TUI repaints
        // the green/yellow status dot on already-streaming tabs
        // immediately — without this the indicator disappears until
        // the next chat.delta / engine.status / chat.event arrives.
        const runState: Record<string, string> = {}
        for (const [key, value] of orch.chatRunStateSignal()()) runState[key] = value
        return {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          daemonPid: process.pid,
          clientId: client.id,
          tasks: tasks.map(serializeTask),
          pending,
          runState,
          planUsage: planUsagePoller.current(),
          rcBridge: rcBridge.status(),
          activeTaskId: activeState.get(),
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
      case "task.spawn": {
        const repo = requireString(payload, "repo")
        const modelEffort = optionalModelEffort(payload, "modelEffort")
        const vendor = optionalVendor(payload, "vendor")
        const prompt = optionalString(payload, "prompt")
        const task = await orch.createTask({
          repo,
          prompt,
          title: optionalString(payload, "title"),
          branch: optionalString(payload, "branch"),
          baseRef: optionalString(payload, "baseRef"),
          model: optionalString(payload, "model"),
          modelEffort,
          vendor,
        })
        // Subscribe EVERY attached client to the new task's tabs, not
        // just the spawning client. Otherwise other TUIs see task.created
        // but never receive chat.delta / chat.event for the new task —
        // multi-attach real-time sync silently breaks.
        for (const c of clients) subscribeClientToTask(orch, c, task)
        broadcast(clients, { type: "event", name: "task.created", payload: { task: serializeTask(task) } })
        // If the spawner provided a prompt, kick off the run as
        // fire-and-forget so the RPC returns immediately. Without this
        // an agent calling task.spawn (kobe api spawn-task) gets a task
        // stuck in `backlog` with no worktree, no session, no chat —
        // matches the older MCP bridge semantics (`spawn_task` always
        // ran the task). The TUI's RemoteOrchestrator.spawnTask omits
        // the prompt and uses a separate chat.send for the first
        // message, so this branch is a no-op for it.
        if (prompt) {
          void orch.runTask(task.id, prompt).catch((err) => {
            // Don't crash the daemon on a spawn-and-run that fails
            // (worktree contention, engine missing, dirty repo). The
            // task still exists; the user can retry from the TUI.
            const msg = err instanceof Error ? err.message : String(err)
            broadcast(clients, {
              type: "event",
              name: "engine.status",
              payload: { taskId: task.id, tabId: task.activeTabId, status: "error", message: msg },
            })
          })
        }
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
        // Clear active if the deleted task was the foregrounded one —
        // pane subprocesses then re-render their "no active task" branch
        // instead of hanging onto a stale id.
        if (activeState.get() === taskId) activeState.set(null)
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
        const modelEffort = optionalModelEffort(payload, "modelEffort")
        const vendor = optionalVendor(payload, "vendor")
        await orch.setModel(
          taskId,
          optionalString(payload, "model"),
          optionalString(payload, "tabId"),
          modelEffort,
          vendor,
        )
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "task.ensureMain": {
        const repo = requireString(payload, "repo")
        // Snapshot the pre-call state so we can distinguish (a) fresh
        // creation, (b) unarchive of a previously-removed-from-saved-
        // repos main task, (c) idempotent no-op. Without this, the
        // freshly-created or unarchived task never reaches other
        // attached clients — RemoteOrchestrator's tasksSignal stays
        // stale and the persisted lastSelectedTaskId can resolve to
        // an "archived" main task that the sidebar / auto-select
        // can't see. Mirrors the pattern used by every other task-
        // mutating handler after the subscribeTasks broadcast was
        // dropped.
        const prior = orch.listTasks().find((t) => t.kind === "main" && t.repo === repo)
        const task = await orch.ensureMainTask(repo)
        if (!prior) {
          // Fresh main task — subscribe every attached client to its
          // tabs (mirrors task.spawn) then broadcast task.created.
          for (const c of clients) subscribeClientToTask(orch, c, task)
          broadcast(clients, { type: "event", name: "task.created", payload: { task: serializeTask(task) } })
        } else if (prior.archived && !task.archived) {
          // Unarchive path inside ensureMainTask — broadcast as an
          // update so sidebar buckets re-sort the row out of Archives.
          broadcastTaskUpdated(orch, clients, task.id)
        }
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
      case "chat.tab.clear": {
        const taskId = requireString(payload, "taskId")
        await orch.clearTab(taskId, requireString(payload, "tabId"))
        // Broadcast the task delta too — `clearTab` dropped the tab's
        // sessionId, so any attached TUI's tab list mirror needs the
        // refresh to reflect the new "fresh tab" state alongside the
        // `chat.tab.cleared` event that resets the reducer.
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "chat.sessions": {
        const sessions = await orch.listSessions(requireString(payload, "taskId"))
        return { sessions }
      }
      case "chat.commands": {
        const commands = await orch.listCommandsForTab(
          requireString(payload, "taskId"),
          requireString(payload, "tabId"),
        )
        return { commands }
      }
      case "chat.session.open": {
        const taskId = requireString(payload, "taskId")
        const tabId = await orch.openSessionInTab(taskId, requireString(payload, "sessionId"), {
          title: optionalString(payload, "title"),
          vendor: optionalVendor(payload, "vendor"),
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
      case "chat.steer": {
        await orch.steerTask(
          requireString(payload, "taskId"),
          requireString(payload, "text"),
          optionalString(payload, "tabId"),
        )
        return {}
      }
      case "chat.recap": {
        await orch.generateRecap(requireString(payload, "taskId"), optionalString(payload, "tabId"))
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
        const taskId = requireString(payload, "taskId")
        await orch.requestPR(taskId)
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "pr.status.refresh": {
        const taskId = requireString(payload, "taskId")
        await orch.refreshPRStatus(taskId)
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "pr.merge.request": {
        const taskId = requireString(payload, "taskId")
        await orch.requestPRMerge(taskId)
        broadcastTaskUpdated(orch, clients, taskId)
        return {}
      }
      case "merge.local.request": {
        const taskId = requireString(payload, "taskId")
        await orch.requestLocalMerge(taskId)
        const task = orch.getTask(taskId)
        if (task) {
          broadcastTaskUpdated(orch, clients, task.id)
          broadcast(clients, {
            type: "event",
            name: "engine.status",
            payload: { taskId: task.id, tabId: task.activeTabId, status: "running" },
          })
        }
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
          ...(result.usageMetrics ? { usageMetrics: result.usageMetrics } : {}),
          nextBefore: result.nextBefore,
          hasMore: result.hasMore,
        } satisfies SerializedHistoryPage
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
        // First-message runs allocate the worktree lazily inside
        // `runTask`: empty `worktreePath` flips to the real path, and
        // `branch` / `status` change too. Without this broadcast, the
        // TUI's RemoteOrchestrator never learns — Files / Terminal
        // panes key off `worktreePath` and stay stuck on the placeholder
        // "no task" state forever. Symptoms: the user types "hi" in a
        // fresh task, sees the worktree-allocated system.info row in
        // chat, but the right column never lights up.
        broadcastTaskUpdated(orch, clients, taskId)
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
      case "rcBridge.start": {
        // Per-tab bridge: callers pass `taskId` so the bridge spawns
        // with `cwd = task.worktreePath` and surfaces the tab's session
        // id in the dialog (so the user can `/resume <sid>` in
        // claude.ai to continue THIS conversation rather than start a
        // fresh one). When `taskId` is omitted (legacy callers, palette
        // command with no active task), we fall back to the git
        // toplevel of the daemon's process cwd — claude.ai still gets
        // a usable environment but bound to no specific session.
        const taskId = optionalString(payload, "taskId")
        const tabId = optionalString(payload, "tabId")
        let cwd: string
        let bound: { taskId: string; tabId: string; sessionId?: string | null; taskTitle?: string } | undefined
        if (taskId) {
          const task = orch.getTask(taskId)
          if (!task) throw new Error(`rcBridge.start: unknown taskId ${taskId}`)
          const resolvedTabId = tabId ?? task.activeTabId
          const tab = task.tabs.find((t) => t.id === resolvedTabId)
          if (!tab) throw new Error(`rcBridge.start: unknown tabId ${resolvedTabId} on task ${taskId}`)
          cwd = task.worktreePath
          bound = {
            taskId: task.id,
            tabId: tab.id,
            sessionId: tab.sessionId,
            taskTitle: task.title,
          }
        } else {
          cwd = optionalString(payload, "cwd") ?? resolveRepoRoot(process.cwd())
        }
        if (!cwd) throw new Error("rcBridge.start requires a non-empty cwd")
        const status = await rcBridge.start({ cwd, bound })
        return { status }
      }
      case "rcBridge.stop": {
        const status = await rcBridge.stop()
        return { status }
      }
      case "rcBridge.status": {
        return { status: rcBridge.status() }
      }
      case "rpc.switchTask": {
        const id = requireString(payload, "id")
        const task = orch.getTask(id)
        if (!task) throw new Error(`unknown task: ${id}`)
        activeState.set(id)
        // Ensure + swap so a never-spawned tab gets spawned + sniffed
        // on demand, rather than swap-into-nothing (KOB-219). Sniff is
        // skipped automatically when the tab already has a sessionId.
        safeEnsureAndSwap(id, task.activeTabId)
        return { ok: true, activeTaskId: id }
      }
      case "rpc.nextTask": {
        const ids = orch
          .listTasks()
          .filter((t) => !t.archived)
          .map((t) => t.id)
        activeState.next(ids)
        const nextId = activeState.get()
        if (nextId) {
          const t = orch.getTask(nextId)
          if (t) safeEnsureAndSwap(nextId, t.activeTabId)
        }
        return { ok: true, activeTaskId: nextId }
      }
      case "rpc.prevTask": {
        const ids = orch
          .listTasks()
          .filter((t) => !t.archived)
          .map((t) => t.id)
        activeState.prev(ids)
        const nextId = activeState.get()
        if (nextId) {
          const t = orch.getTask(nextId)
          if (t) safeEnsureAndSwap(nextId, t.activeTabId)
        }
        return { ok: true, activeTaskId: nextId }
      }
      case "rpc.newTab": {
        const activeTaskId = activeState.get()
        if (activeTaskId === null) throw new Error("no active task")
        const newTab = await orch.createTab(activeTaskId)
        await orch.setActiveTab(activeTaskId, newTab.id)
        // Subscribe every attached client to the new tab's event bus
        // (mirrors chat.tab.create — without this the spawning side
        // sees the tab but never receives chat.delta for it).
        for (const c of clients) subscribeClientToTab(orch, c, activeTaskId, newTab.id)
        broadcastTaskUpdated(orch, clients, activeTaskId)
        // Spawn a fresh stash pane for the new tab + swap it in.
        safeEnsureAndSwap(activeTaskId, newTab.id)
        return { ok: true, tabId: newTab.id }
      }
      case "rpc.closeTab": {
        const activeTaskId = activeState.get()
        if (activeTaskId === null) throw new Error("no active task")
        const task = orch.getTask(activeTaskId)
        if (!task) throw new Error(`unknown task: ${activeTaskId}`)
        if (task.tabs.length < 2) return { ok: true, skipped: "only-one-tab" }
        const closingTabId = task.activeTabId
        const nextActive = await orch.closeTab(activeTaskId, closingTabId)
        broadcastTaskUpdated(orch, clients, activeTaskId)
        // The orchestrator has already moved active focus to `nextActive`.
        // Route through safeEnsureAndSwap so a sibling tab that never
        // had a stash pane spawned gets one on demand (KOB-219). Then
        // kill the closing tab's stash pane.
        if (nextActive) safeEnsureAndSwap(activeTaskId, nextActive)
        safeKill(activeTaskId, closingTabId)
        return { ok: true, nextActive }
      }
      case "tmux.attach": {
        const session = requireString(payload, "session")
        const stashWindow = requireString(payload, "stashWindow")
        const chatSlotPaneId = requireString(payload, "chatSlotPaneId")
        const savedLayout = requireString(payload, "savedLayout")
        // Spawn the control client + bind the pure pane-stash state
        // machine to the just-built layout. Both replace any previously
        // installed instances; sprint-6 doesn't expect re-attach in
        // production, but tests and a future "kobe attach" verb may
        // call this more than once per daemon lifetime.
        if (tmuxClient) {
          // Null the holder BEFORE closing so the `on("close")` listener
          // skips the "unexpected exit" branch (see the listener below).
          const prev = tmuxClient
          tmuxClient = null
          try {
            await prev.close()
          } catch (err) {
            logDaemonError("tmux-client-replace", err)
          }
        }
        const client = await spawnControlClient({ session })
        client.on("close", (info: unknown) => {
          // Only log unexpected exits. `serverApi.close` and the
          // re-attach branch above explicitly null `tmuxClient` before
          // tearing the subprocess down — those teardowns shouldn't
          // surface as errors. Logging unexpected exits surfaces
          // mid-session tmux deaths (someone ran `tmux kill-server`,
          // OOM, etc.) that would otherwise silently break swaps.
          if (tmuxClient === client) {
            logDaemonError(
              "tmux-client-exit",
              new Error(`tmux control client closed unexpectedly: ${JSON.stringify(info)}`),
            )
            tmuxClient = null
          }
        })
        tmuxClient = client
        const stash = createPaneStash()
        stash.attach({ stashWindow, chatSlotPaneId, savedLayout })
        const adapter = new PaneStashAdapter({ stash, client })
        paneStashAdapter = adapter
        // Resolve + cache the claude binary once. Tabs that haven't
        // been spawned yet will call `buildClaudeShellCommand` against
        // this; resumed tabs pass their persisted sessionId through.
        const binaryPath = await findClaudeBinary()
        resolvePaneCommand = (taskId, tabId) => {
          const task = orch.getTask(taskId)
          if (!task) return null
          const tab = task.tabs.find((t) => t.id === tabId)
          if (!tab) return null
          return buildClaudeShellCommand({
            binaryPath,
            cwd: task.worktreePath,
            resumeSessionId: tab.sessionId ?? undefined,
          })
        }
        // If the user already had an active task in flight before this
        // attach (daemon-survives-bootstrap restart, mostly a future-
        // proofing case for now), re-bridge the chat slot so the visible
        // pane matches state.
        const activeId = activeState.get()
        if (activeId) {
          const t = orch.getTask(activeId)
          if (t) safeEnsureAndSwap(activeId, t.activeTabId)
        }
        return { ok: true }
      }
      case "rpc.switchTab": {
        const activeTaskId = activeState.get()
        if (activeTaskId === null) throw new Error("no active task")
        const task = orch.getTask(activeTaskId)
        if (!task) throw new Error(`unknown task: ${activeTaskId}`)
        const tabIdArg = requireString(payload, "tabId")
        let resolvedId: string
        if (/^\d+$/.test(tabIdArg)) {
          const idx = Number(tabIdArg) - 1
          const tab = task.tabs[idx]
          if (!tab) return { ok: true, skipped: "out-of-range" }
          resolvedId = tab.id
        } else {
          resolvedId = tabIdArg
        }
        await orch.setActiveTab(activeTaskId, resolvedId)
        broadcastTaskUpdated(orch, clients, activeTaskId)
        // Ensure + swap so a never-spawned sibling tab gets spawned +
        // sniffed on demand (KOB-219).
        safeEnsureAndSwap(activeTaskId, resolvedId)
        return { ok: true, tabId: resolvedId }
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
  usageMetrics?: SessionUsageMetrics
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
  const { messages, usageMetrics } = await orch.readHistoryWithMetrics(sessionId)
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
  return { messages: page, ...(usageMetrics ? { usageMetrics } : {}), nextBefore, hasMore }
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

function optionalModelEffort(payload: Record<string, unknown>, key: string): ModelEffortLevel | undefined {
  const value = optionalString(payload, key)
  if (
    value !== undefined &&
    value !== "none" &&
    value !== "minimal" &&
    value !== "low" &&
    value !== "medium" &&
    value !== "high" &&
    value !== "xhigh" &&
    value !== "max"
  ) {
    throw new Error(`${key} must be a supported effort level`)
  }
  return value
}

function optionalVendor(payload: Record<string, unknown>, key: string): VendorId | undefined {
  const value = optionalString(payload, key)
  if (value !== undefined && value !== "claude" && value !== "codex" && value !== "gemini") {
    throw new Error(`${key} '${value}' is not a supported vendor (expected: claude, codex, gemini)`)
  }
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

/**
 * List a directory, returning an empty array if the directory does not
 * yet exist. Used as the pre-spawn snapshot for the Claude Code
 * session-id sniff — a tab spawning into a worktree that has never run
 * `claude` before will have no `~/.claude/projects/<encoded-cwd>/` at
 * all, and that's a successful "no prior sessions" result, not an error.
 */
async function safeListDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * Poll `sniffNewSessionId` until a new `<sid>.jsonl` appears in the
 * worktree's claude project dir or the budget runs out. Defaults match
 * the sprint-6 brief (500ms interval, 5s budget — claude usually
 * writes the JSONL within ~1s of first prompt). Returns null on
 * timeout so the caller can log a warning and move on.
 */
async function pollForSessionId(
  cwd: string,
  before: ReadonlySet<string>,
  intervalMs = 500,
  timeoutMs = 5000,
): Promise<string | null> {
  const deps = {
    encodeCwd,
    list: safeListDir,
    homedir,
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sid = await sniffNewSessionId(cwd, before, deps)
    if (sid) return sid
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return null
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
