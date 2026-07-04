/**
 * Daemon-hosted local HTTP/SSE transport for kobe web and desktop.
 */

import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import { availableEngineIds } from "@/engine/account-detect"
import {
  defaultEngineCommand,
  engineCommandKey,
  engineDisplayName,
  engineNameKey,
  kobeApiInvocation,
} from "@/engine/interactive-command"
import { engineEntry } from "@/engine/registry"
import {
  normalizeRunTurnEffort,
  runTurnEffortKey,
  runTurnModelKey,
  runTurnSettingsFromState,
  runTurnSmallModelKey,
} from "@/engine/run-turn-settings"
import type { Orchestrator } from "@/orchestrator/core"
import { AUTO_STATUS_KEY } from "@/state/auto-status"
import { DISPATCHER_KEY } from "@/state/dispatcher"
import { getPersistedString, getSavedRepos, setPersistedString } from "@/state/repos"
import { loadStateFile, patchStateFile } from "@/state/store"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KINDS,
  EDITOR_KIND_KEY,
  normalizeEditorKind,
} from "@/tui/lib/editor-prefs"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "@/tui/lib/settings-surface"
import type { VendorId } from "@/types/task"
import { BUILTIN_VENDORS, isBuiltinVendor } from "@/types/vendor"
import { handleDiffRequest } from "@/web/diff"
import { handleHistoryRequest } from "@/web/history"
import { handleNotesRequest } from "@/web/notes"
import { handleThemesRequest } from "@/web/themes"
import type { DaemonRpcClient } from "../client/rpc.ts"
import type { DaemonActivityRegistry } from "./activity-registry.ts"
import type { ChannelEvent, DaemonEventBus } from "./event-bus.ts"
import { type DaemonHandlerContext, createDaemonHandlerRegistry, dispatchDaemonRequest } from "./handlers.ts"
import type { ChannelName, ChannelPayloads, DaemonRequestName, SerializedTask } from "./protocol.ts"
import { serializeTask } from "./protocol.ts"
import { handleIssueAssetsRequest } from "./web-issue-assets-route.ts"
import { handleIssuesRequest } from "./web-issues-route.ts"
import { allowedHostForBindHost, originAllowed } from "./web-origin.ts"
import { WEB_RPC_ALLOWSET } from "./web-rpc-allowlist.ts"
import { engineSpec, ensureTaskSession, tearDownTaskSession, terminalSpec } from "./web-session.ts"

export const DAEMON_WEB_HEALTH_MARKER = "kobe-web"
export const DAEMON_WEB_HEALTH_PATH = "/__kobe_web"

type SseSend = (type: string, data: unknown) => void

export interface DaemonWebSnapshotState {
  tasks: SerializedTask[]
  activeTaskId: string | null
  engineStates: Record<string, ChannelPayloads["engine-state"]>
  update: ChannelPayloads["update"]["info"]
  jobs: Record<string, ChannelPayloads["task.jobs"]>
  worktreeChanges: ChannelPayloads["worktree.changes"]["changes"]
  issueSnapshots: Record<string, ChannelPayloads["issue.snapshot"]>
  deliver: ChannelPayloads["session.deliver"] | null
  uiPrefs: ChannelPayloads["ui-prefs"] | null
  connected: boolean
}

export interface DaemonWebLink extends DaemonRpcClient {
  snapshot(): DaemonWebSnapshotState
}

export interface RequestHandlerDeps {
  link: DaemonWebLink
  sseSends: Set<SseSend>
  staticDir?: string
  tearDownSession?: (taskId: string) => void
  allowedHost?: string
  onSseOpen?: () => () => void
}

export interface DaemonWebServerOptions {
  port: number
  hostname?: string
  staticDir?: string
  takeover?: boolean
  link: DaemonWebLink
  onEvent: (sink: (event: ChannelEvent) => void) => () => void
  onSseOpen?: () => () => void
}

export interface DaemonWebServer {
  readonly port: number
  readonly hostname: string
  close(): void
}

function sseResponse(register: (send: SseSend) => () => void): Response {
  let unregister: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const send: SseSend = (type, data) => {
        try {
          controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          /* stream already closed */
        }
      }
      unregister = register(send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"))
        } catch {
          /* stream already closed */
        }
      }, 15_000)
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat)
      unregister?.()
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

async function rpcResponse(req: Request, link: DaemonWebLink, tearDown: (taskId: string) => void): Promise<Response> {
  try {
    const { name, payload } = (await req.json()) as { name?: DaemonRequestName; payload?: unknown }
    if (!name) return Response.json({ error: "missing rpc name" }, { status: 400 })
    if (!WEB_RPC_ALLOWSET.has(name)) {
      return Response.json({ error: `rpc ${name} is not exposed to the web UI` }, { status: 403 })
    }
    const result = await link.request(name, payload)
    const taskId = (payload as { taskId?: unknown } | undefined)?.taskId
    if (typeof taskId === "string") {
      const archiving = name === "task.archive" && (payload as { archived?: unknown }).archived !== false
      if (name === "task.delete" || archiving) tearDown(taskId)
    }
    return Response.json({ result })
  } catch (err) {
    const name = err instanceof Error && err.name !== "Error" ? err.name : undefined
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), ...(name ? { name } : {}) },
      { status: 500 },
    )
  }
}

async function enginesResponse(): Promise<Response> {
  try {
    const ids = await availableEngineIds()
    const engines = ids.map((id) => ({
      id,
      label: engineDisplayName(id),
      effortLevels: engineEntry(id).effortLevels,
    }))
    return Response.json({ engines: engines.length > 0 ? engines : [{ id: "claude", label: "Claude" }] })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

function cliInvocationResponse(): Response {
  return Response.json({ api: kobeApiInvocation() })
}

function projectsResponse(): Response {
  return Response.json({ projects: getSavedRepos() })
}

const FOCUS_ACCENTS = ["primary", "success", "info"] as const
const ENGINE_ID_RE = /^[a-z][a-z0-9_-]{0,47}$/

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function customEngineIdsFrom(state: Record<string, unknown>): string[] {
  const raw = state.customEngineIds
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === "string" && ENGINE_ID_RE.test(id) && !isBuiltinVendor(id))
}

function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

function engineLabelText(state: Record<string, unknown>, id: VendorId): string {
  const custom = stringValue(state[engineNameKey(id)]).trim()
  return custom || engineDisplayName(id)
}

function engineCommandText(state: Record<string, unknown>, id: VendorId): string {
  const custom = stringValue(state[engineCommandKey(id)]).trim()
  return custom || defaultEngineCommand(id).join(" ")
}

function settingsSnapshot(): Response {
  const state = loadStateFile()
  const custom = customEngineIdsFrom(state)
  const engineIds = [...BUILTIN_VENDORS, ...custom] as VendorId[]
  const defaultEngine = stringValue(state.lastSelectedVendor, "claude")
  const focusAccent = stringValue(state.focusAccent, "primary")
  return Response.json({
    activeTheme: stringValue(state.activeTheme, "claude"),
    transparentBackground: boolValue(state.transparentBackground, false),
    focusAccent: FOCUS_ACCENTS.includes(focusAccent as (typeof FOCUS_ACCENTS)[number]) ? focusAccent : "primary",
    notificationsToast: state["notifications.toast.enabled"] !== false,
    notificationsSound: state["notifications.sound.enabled"] !== false,
    settingsSurface: normalizeSettingsSurface(state[SETTINGS_SURFACE_KEY] ?? DEFAULT_SETTINGS_SURFACE),
    editorKind: normalizeEditorKind(state[EDITOR_KIND_KEY] ?? DEFAULT_EDITOR_KIND),
    editorCustomCommand: stringValue(state[EDITOR_CUSTOM_KEY]),
    remoteProjects: state["experimental.remoteProjects"] === true,
    archivedHistoryPreview: state["experimental.archivedHistoryPreview"] === true,
    autoStatus: state[AUTO_STATUS_KEY] === true,
    dispatcher: state[DISPATCHER_KEY] === true,
    defaultEngine,
    engines: engineIds.map((id) => {
      const runTurn = runTurnSettingsFromState(state, id)
      return {
        id,
        label: engineLabelText(state, id),
        command: engineCommandText(state, id),
        runTurnModel: runTurn.model,
        runTurnSmallModel: runTurn.smallModel,
        runTurnEffort: runTurn.effort,
        runTurnEffortLevels: runTurn.effortLevels,
        isBuiltin: isBuiltinVendor(id),
        isCustom: !isBuiltinVendor(id),
        isDefault: id === defaultEngine,
      }
    }),
  })
}

function putIfString(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "string") patch[key] = value.trim()
}

function putIfBool(patch: Record<string, unknown>, key: string, value: unknown): void {
  if (typeof value === "boolean") patch[key] = value
}

async function settingsPatch(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    putIfString(patch, "activeTheme", body.activeTheme)
    putIfBool(patch, "transparentBackground", body.transparentBackground)
    if (FOCUS_ACCENTS.includes(body.focusAccent as (typeof FOCUS_ACCENTS)[number])) {
      patch.focusAccent = body.focusAccent
    }
    putIfBool(patch, "notifications.toast.enabled", body.notificationsToast)
    putIfBool(patch, "notifications.sound.enabled", body.notificationsSound)
    if (body.settingsSurface === "chattab" || body.settingsSurface === "taskpanel") {
      patch[SETTINGS_SURFACE_KEY] = body.settingsSurface
    }
    if (EDITOR_KINDS.includes(body.editorKind as (typeof EDITOR_KINDS)[number]))
      patch[EDITOR_KIND_KEY] = body.editorKind
    putIfString(patch, EDITOR_CUSTOM_KEY, body.editorCustomCommand)
    putIfBool(patch, "experimental.remoteProjects", body.remoteProjects)
    putIfBool(patch, "experimental.archivedHistoryPreview", body.archivedHistoryPreview)
    putIfBool(patch, AUTO_STATUS_KEY, body.autoStatus)
    putIfBool(patch, DISPATCHER_KEY, body.dispatcher)
    putIfString(patch, "lastSelectedVendor", body.defaultEngine)

    const state = loadStateFile()
    const custom = customEngineIdsFrom(state)
    const known = new Set<string>([...BUILTIN_VENDORS, ...custom])

    const updates = Array.isArray(body.engineUpdates) ? body.engineUpdates : []
    for (const raw of updates) {
      if (!raw || typeof raw !== "object") continue
      const update = raw as {
        id?: unknown
        command?: unknown
        label?: unknown
        runTurnModel?: unknown
        runTurnSmallModel?: unknown
        runTurnEffort?: unknown
      }
      if (typeof update.id !== "string" || !known.has(update.id)) continue
      putIfString(patch, engineCommandKey(update.id), update.command)
      putIfString(patch, engineNameKey(update.id), update.label)
      putIfString(patch, runTurnModelKey(update.id), update.runTurnModel)
      putIfString(patch, runTurnSmallModelKey(update.id), update.runTurnSmallModel)
      if (typeof update.runTurnEffort === "string") {
        const effort = update.runTurnEffort.trim()
        if (effort.length === 0 || normalizeRunTurnEffort(update.id, effort) === effort) {
          patch[runTurnEffortKey(update.id)] = effort
        }
      }
    }

    if (body.addEngine && typeof body.addEngine === "object") {
      const add = body.addEngine as { id?: unknown; command?: unknown; label?: unknown }
      const id = typeof add.id === "string" ? add.id.trim().toLowerCase() : ""
      if (!ENGINE_ID_RE.test(id) || isBuiltinVendor(id) || known.has(id)) {
        return Response.json({ error: "invalid or duplicate engine id" }, { status: 400 })
      }
      patch.customEngineIds = [...custom, id]
      patch[engineCommandKey(id)] = stringValue(add.command).trim()
      const label = stringValue(add.label).trim()
      patch[engineNameKey(id)] = label && label !== id ? label : humanizeSlug(id)
    }

    if (typeof body.removeEngine === "string") {
      const id = body.removeEngine
      if (!isBuiltinVendor(id)) {
        patch.customEngineIds = custom.filter((engine) => engine !== id)
        patch[engineCommandKey(id)] = undefined
        patch[engineNameKey(id)] = undefined
        patch[runTurnModelKey(id)] = undefined
        patch[runTurnSmallModelKey(id)] = undefined
        patch[runTurnEffortKey(id)] = undefined
        if (state.lastSelectedVendor === id) patch.lastSelectedVendor = "claude"
      }
    }

    if (Object.keys(patch).length > 0) patchStateFile(patch)
    return settingsSnapshot()
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

async function sessionResponse(req: Request, link: DaemonWebLink): Promise<Response> {
  try {
    const { taskId } = (await req.json()) as { taskId?: string }
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await ensureTaskSession(link, taskId))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function specResponse(
  url: URL,
  link: DaemonWebLink,
  spec: (link: DaemonWebLink, taskId: string) => Promise<{ cwd: string; command: string[] }>,
): Promise<Response> {
  try {
    const taskId = url.searchParams.get("taskId")
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await spec(link, taskId))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

const QUICK_PROMPT_KEYS = {
  review: "boardPrompt.review",
  pr: "boardPrompt.pr",
} as const

function quickPromptsGet(): Response {
  return Response.json({
    review: getPersistedString(QUICK_PROMPT_KEYS.review) ?? null,
    pr: getPersistedString(QUICK_PROMPT_KEYS.pr) ?? null,
  })
}

async function quickPromptsPut(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { review?: unknown; pr?: unknown }
    if (typeof body.review === "string") setPersistedString(QUICK_PROMPT_KEYS.review, body.review)
    if (typeof body.pr === "string") setPersistedString(QUICK_PROMPT_KEYS.pr, body.pr)
    return quickPromptsGet()
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

async function staticResponse(pathname: string, staticDir: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname
  const resolved = normalize(join(staticDir, rel))
  if (!resolved.startsWith(staticDir)) return new Response("forbidden", { status: 403 })
  const file = Bun.file(existsSync(resolved) ? resolved : join(staticDir, "index.html"))
  if (!(await file.exists())) {
    return new Response("kobe web assets not built — run `bun --filter kobe-web build`", { status: 503 })
  }
  return new Response(file)
}

export function createDaemonWebRequestHandler(deps: RequestHandlerDeps): (req: Request) => Promise<Response> {
  const { link, sseSends, staticDir } = deps
  const tearDown = deps.tearDownSession ?? ((taskId: string) => void tearDownTaskSession(taskId))
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === DAEMON_WEB_HEALTH_PATH) return new Response(DAEMON_WEB_HEALTH_MARKER)
    if (!originAllowed(req.headers.get("origin"), { allowedHost: deps.allowedHost })) {
      return new Response("forbidden: cross-origin request rejected", { status: 403 })
    }
    if (url.pathname === "/events") {
      return sseResponse((send) => {
        const closeGui = deps.onSseOpen?.() ?? (() => {})
        send("snapshot", link.snapshot())
        sseSends.add(send)
        return () => {
          sseSends.delete(send)
          closeGui()
        }
      })
    }
    if (url.pathname === "/api/rpc" && req.method === "POST") return rpcResponse(req, link, tearDown)
    if (url.pathname === "/api/session" && req.method === "POST") return sessionResponse(req, link)
    if (url.pathname === "/api/engine-spec" && req.method === "GET") return specResponse(url, link, engineSpec)
    if (url.pathname === "/api/terminal-spec" && req.method === "GET") {
      return specResponse(url, link, terminalSpec)
    }
    if (url.pathname === "/api/engines" && req.method === "GET") return enginesResponse()
    if (url.pathname === "/api/cli-invocation" && req.method === "GET") return cliInvocationResponse()
    if (url.pathname === "/api/projects" && req.method === "GET") return projectsResponse()
    if (url.pathname === "/api/settings" && req.method === "GET") return settingsSnapshot()
    if (url.pathname === "/api/settings" && req.method === "PATCH") return settingsPatch(req)
    if (url.pathname === "/api/quick-prompts" && req.method === "GET") return quickPromptsGet()
    if (url.pathname === "/api/quick-prompts" && req.method === "PUT") return quickPromptsPut(req)
    const notes = await handleNotesRequest(req, url)
    if (notes) return notes
    const diff = await handleDiffRequest(req, url)
    if (diff) return diff
    const history = await handleHistoryRequest(req, url)
    if (history) return history
    const issues = await handleIssuesRequest(req, url, link)
    if (issues) return issues
    const issueAssets = await handleIssueAssetsRequest(req, url)
    if (issueAssets) return issueAssets
    const themes = handleThemesRequest(req, url)
    if (themes) return themes
    if (staticDir) return staticResponse(url.pathname, staticDir)
    return new Response("not found", { status: 404 })
  }
}

function latest<C extends ChannelName>(bus: DaemonEventBus, channel: C): ChannelPayloads[C] | null {
  const found = bus.snapshot().find((event) => event.channel === channel)
  return found ? (found.payload as ChannelPayloads[C]) : null
}

function normalizeRepoPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

function repoSnapshotAliases(tasks: readonly SerializedTask[], repoRoot: string): string[] {
  const root = normalizeRepoPath(repoRoot)
  const aliases = new Set<string>([repoRoot])
  for (const task of tasks) {
    const taskRepo = normalizeRepoPath(task.repo)
    const taskWorktree = normalizeRepoPath(task.worktreePath)
    if (taskRepo === root || taskWorktree === root) {
      if (task.repo) aliases.add(task.repo)
      if (task.worktreePath) aliases.add(task.worktreePath)
    }
  }
  return [...aliases]
}

export function createDirectWebLink(args: {
  orch: Orchestrator
  bus: DaemonEventBus
  activity: DaemonActivityRegistry
  ctx: (clientId: number) => DaemonHandlerContext
}): DaemonWebLink {
  const handlers = createDaemonHandlerRegistry()
  return {
    async request<T>(name: DaemonRequestName, payload?: unknown): Promise<T> {
      return (await dispatchDaemonRequest(handlers, name, payload, args.ctx(0))) as T
    },
    snapshot(): DaemonWebSnapshotState {
      const tasks = args.orch.listTasks().map(serializeTask)
      const issueSnapshots: Record<string, ChannelPayloads["issue.snapshot"]> = {}
      const issue = latest(args.bus, "issue.snapshot")
      if (issue) {
        for (const alias of repoSnapshotAliases(tasks, issue.repoRoot))
          issueSnapshots[alias] = { ...issue, repoRoot: alias }
      }
      const job = latest(args.bus, "task.jobs")
      const jobs: Record<string, ChannelPayloads["task.jobs"]> = job?.phase === "running" ? { [job.taskId]: job } : {}
      return {
        tasks,
        activeTaskId: latest(args.bus, "active-task")?.taskId ?? null,
        engineStates: args.activity.snapshotByTask(),
        update: latest(args.bus, "update")?.info ?? null,
        jobs,
        worktreeChanges: latest(args.bus, "worktree.changes")?.changes ?? {},
        issueSnapshots,
        deliver: latest(args.bus, "session.deliver"),
        uiPrefs: latest(args.bus, "ui-prefs"),
        connected: true,
      }
    },
  }
}

async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    return out
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid)
  } catch {
    return []
  }
}

export async function takeoverWebPort(port: number, healthPath: string = DAEMON_WEB_HEALTH_PATH): Promise<void> {
  let body: string
  try {
    const res = await fetch(`http://localhost:${port}${healthPath}`, { signal: AbortSignal.timeout(800) })
    body = (await res.text()).trim()
  } catch {
    return
  }
  if (body !== DAEMON_WEB_HEALTH_MARKER) {
    throw new Error(`port ${port} is in use by a non-kobe service; refusing to replace it`)
  }
  const pids = await pidsOnPort(port)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if ((await pidsOnPort(port)).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

export async function startDaemonWebServer(opts: DaemonWebServerOptions): Promise<DaemonWebServer> {
  if (opts.takeover !== false) await takeoverWebPort(opts.port)
  const sseSends = new Set<SseSend>()
  const unsubscribe = opts.onEvent((event) => {
    for (const send of sseSends) send("channel", event)
  })
  const hostname = opts.hostname?.trim() || process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
  const allowedHost = allowedHostForBindHost(hostname)
  const handle = createDaemonWebRequestHandler({
    link: opts.link,
    sseSends,
    staticDir: opts.staticDir ? normalize(opts.staticDir) : undefined,
    allowedHost,
    onSseOpen: opts.onSseOpen,
  })
  const server = Bun.serve({ port: opts.port, hostname, idleTimeout: 0, fetch: handle })
  return {
    port: server.port ?? opts.port,
    hostname,
    close() {
      unsubscribe()
      server.stop(true)
    },
  }
}
