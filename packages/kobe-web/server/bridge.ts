/**
 * kobe web bridge — a standalone HTTP/SSE server in front of the daemon.
 *
 * This process is the web UI's backend: it owns the browser-facing port and
 * talks to the kobe daemon purely over the socket protocol (see
 * daemon-link.ts). It is deliberately NOT daemon-hosted: the dashboard is
 * experimental and iterates fast, so its code must be restartable without
 * touching the daemon that holds every task — and a bridge crash must never
 * take the daemon down with it.
 *
 * Routes:
 *   GET  /__kobe_web          health marker (port-takeover handshake)
 *   GET  /events              SSE: `snapshot` on connect, then `channel` pushes
 *   POST /api/rpc             forward an ALLOWLISTED daemon RPC by name
 *   POST /api/session         ensure a task's tmux session exists
 *   GET  /api/engine-spec     PTY launch spec for a task's engine tab
 *   GET  /api/terminal-spec   PTY launch spec for a task's shell tab
 *   GET  /api/engines         engine-owned vendor list (id + label + effort)
 *   GET  /api/projects        saved project repos from state.json
 *   GET/PATCH /api/settings   shared TUI/web settings backed by state.json
 *   *    /api/notes, /api/diff       bridge-local filesystem routes
 *   *    /api/issue-assets           bridge-local issue-attachment store
 *   *    /api/issues                 daemon-owned issue tracker proxy
 *   *                         static SPA fallthrough when `staticDir` is set
 */

import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { availableEngineIds } from "../../kobe/src/engine/account-detect.ts"
import {
  defaultEngineCommand,
  engineCommandKey,
  engineDisplayName,
  engineNameKey,
  kobeApiInvocation,
} from "../../kobe/src/engine/interactive-command.ts"
import { engineEntry } from "../../kobe/src/engine/registry.ts"
import { AUTO_STATUS_KEY } from "../../kobe/src/state/auto-status.ts"
import { DISPATCHER_KEY } from "../../kobe/src/state/dispatcher.ts"
import { getPersistedString, getSavedRepos, setPersistedString } from "../../kobe/src/state/repos.ts"
import { loadStateFile, patchStateFile } from "../../kobe/src/state/store.ts"
import {
  DEFAULT_EDITOR_KIND,
  EDITOR_CUSTOM_KEY,
  EDITOR_KIND_KEY,
  EDITOR_KINDS,
  normalizeEditorKind,
} from "../../kobe/src/tui/lib/editor-prefs.ts"
import {
  DEFAULT_SETTINGS_SURFACE,
  SETTINGS_SURFACE_KEY,
  normalizeSettingsSurface,
} from "../../kobe/src/tui/lib/settings-surface.ts"
import type { VendorId } from "../../kobe/src/types/task.ts"
import { BUILTIN_VENDORS, isBuiltinVendor } from "../../kobe/src/types/vendor.ts"
import { handleDiffRequest } from "../../kobe/src/web/diff.ts"
import { handleHistoryRequest } from "../../kobe/src/web/history.ts"
import { handleNotesRequest } from "../../kobe/src/web/notes.ts"
import { handleThemesRequest } from "../../kobe/src/web/themes.ts"
import { DaemonLink } from "./daemon-link.ts"
import { handleIssueAssetsRequest } from "./issue-assets-route.ts"
import { handleIssuesRequest } from "./issues-route.ts"
import { WEB_RPC_ALLOWSET } from "./rpc-allowlist.ts"
import { engineSpec, ensureTaskSession, tearDownTaskSession, terminalSpec } from "./session.ts"

export const WEB_HEALTH_MARKER = "kobe-web"
export const WEB_HEALTH_PATH = "/__kobe_web"

export interface BridgeServerOptions {
  port?: number
  staticDir?: string
  takeover?: boolean
}

export interface BridgeServer {
  readonly port: number
  close(): void
}

type SseSend = (type: string, data: unknown) => void

/**
 * The slice of {@link DaemonLink} the request handler needs — extracted so
 * the route table can be tested against a fake link (no socket, no daemon).
 */
export interface BridgeLink {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
  snapshot(): unknown
}

/** Dependencies for {@link createRequestHandler} — all injectable so the
 *  full route table is unit-testable. */
export interface RequestHandlerDeps {
  link: BridgeLink
  /** Open SSE sinks; /events registers into this set, the fan-out reads it. */
  sseSends: Set<SseSend>
  staticDir?: string
  /** tmux teardown after a committed archive/delete (default: real tmux). */
  tearDownSession?: (taskId: string) => void
  /** The non-loopback host the server is deliberately bound to (KOBE_WEB_HOST),
   *  if any. Requests whose Origin is this host are allowed through the
   *  cross-origin guard so the documented LAN-exposure override keeps working;
   *  undefined for the default loopback bind. */
  allowedHost?: string
}

/**
 * Cross-origin guard for the bridge — the same defense the PTY sidecar applies
 * (see pty-server.mjs `LOCAL_ORIGIN`/`verifyClient`). The bridge's mutating
 * routes (`/api/rpc` reaches task.create/delete/archive/rename, `/api/settings`,
 * `/api/issues`, `/api/issue-assets`, `/api/session`) drive real side effects,
 * so a page the user merely visits must not be able to invoke them. A browser
 * always stamps `Origin` on a fetch/EventSource; only loopback pages (or the
 * deliberately-configured LAN host) may pass. This also blunts DNS-rebinding:
 * a rebound `attacker.com → 127.0.0.1` page still carries `Origin: attacker.com`
 * and is rejected. Non-browser clients send no Origin — there's no browser to
 * forge their request — so they're allowed (the daemon socket, `kobe api`, and
 * the port-takeover health probe all hit it Origin-less).
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/

function originAllowed(req: Request, allowedHost?: string): boolean {
  const origin = req.headers.get("origin")
  if (!origin) return true
  if (LOCAL_ORIGIN.test(origin)) return true
  if (allowedHost) {
    try {
      if (new URL(origin).hostname === allowedHost) return true
    } catch {
      /* malformed Origin → reject */
    }
  }
  return false
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
          /* stream already closed — cancel() handles cleanup */
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

async function rpcResponse(
  req: Request,
  link: BridgeLink,
  tearDown: (taskId: string) => void,
): Promise<Response> {
  try {
    const { name, payload } = (await req.json()) as { name?: DaemonRequestName; payload?: unknown }
    if (!name) return Response.json({ error: "missing rpc name" }, { status: 400 })
    if (!WEB_RPC_ALLOWSET.has(name)) {
      return Response.json({ error: `rpc ${name} is not exposed to the web UI` }, { status: 403 })
    }
    const result = await link.request(name, payload)
    // The daemon never touches tmux: after a committed archive/delete, the
    // session (and the engine inside it) must be torn down by the front-end
    // that asked — same contract as the TUI flows and `kobe api`. Delete
    // always kills; archive kills only when actually archiving (un-archive
    // passes `archived: false` and must leave a live session alone).
    const taskId = (payload as { taskId?: unknown } | undefined)?.taskId
    if (typeof taskId === "string") {
      const archiving =
        name === "task.archive" && (payload as { archived?: unknown }).archived !== false
      if (name === "task.delete" || archiving) tearDown(taskId)
    }
    return Response.json({ result })
  } catch (err) {
    // Forward the daemon's error NAME alongside the message so the SPA can
    // branch on typed failures (e.g. IllegalTransitionError → board rollback
    // toast) without string-matching.
    const name = err instanceof Error && err.name !== "Error" ? err.name : undefined
    return Response.json(
      { error: err instanceof Error ? err.message : String(err), ...(name ? { name } : {}) },
      { status: 500 },
    )
  }
}

/** Engine-owned vendor list: detected built-ins + user-registered custom
 *  engines, labeled with their (possibly user-overridden) display names and
 *  carrying each engine's reasoning/effort levels from the registry — so the
 *  SPA never hard-codes vendor strings or effort options (CLAUDE.md:
 *  engine-owned UI data). Falls back to the always-shippable claude entry on
 *  probe failure (claude has no kobe-driveable effort flag → no levels). */
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
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []
}

function humanizeSlug(id: string): string {
  return id
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function engineCommandText(state: Record<string, unknown>, id: VendorId): string {
  const override = stringValue(state[engineCommandKey(id)]).trim()
  return override || defaultEngineCommand(id).join(" ")
}

function engineLabelText(state: Record<string, unknown>, id: VendorId): string {
  const override = stringValue(state[engineNameKey(id)]).trim()
  return override || engineDisplayName(id)
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
    autoStatus: state[AUTO_STATUS_KEY] === true,
    dispatcher: state[DISPATCHER_KEY] === true,
    defaultEngine,
    engines: engineIds.map((id) => ({
      id,
      label: engineLabelText(state, id),
      command: engineCommandText(state, id),
      isBuiltin: isBuiltinVendor(id),
      isCustom: !isBuiltinVendor(id),
      isDefault: id === defaultEngine,
    })),
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
    if (EDITOR_KINDS.includes(body.editorKind as (typeof EDITOR_KINDS)[number])) patch[EDITOR_KIND_KEY] = body.editorKind
    putIfString(patch, EDITOR_CUSTOM_KEY, body.editorCustomCommand)
    putIfBool(patch, "experimental.remoteProjects", body.remoteProjects)
    putIfBool(patch, AUTO_STATUS_KEY, body.autoStatus)
    putIfBool(patch, DISPATCHER_KEY, body.dispatcher)
    putIfString(patch, "lastSelectedVendor", body.defaultEngine)

    const state = loadStateFile()
    const custom = customEngineIdsFrom(state)
    const known = new Set<string>([...BUILTIN_VENDORS, ...custom])

    const updates = Array.isArray(body.engineUpdates) ? body.engineUpdates : []
    for (const raw of updates) {
      if (!raw || typeof raw !== "object") continue
      const update = raw as { id?: unknown; command?: unknown; label?: unknown }
      if (typeof update.id !== "string" || !known.has(update.id)) continue
      putIfString(patch, engineCommandKey(update.id), update.command)
      putIfString(patch, engineNameKey(update.id), update.label)
    }

    if (body.addEngine && typeof body.addEngine === "object") {
      const add = body.addEngine as { id?: unknown; command?: unknown; label?: unknown }
      const id = typeof add.id === "string" ? add.id.trim().toLowerCase() : ""
      if (!ENGINE_ID_RE.test(id) || isBuiltinVendor(id) || known.has(id)) {
        return Response.json({ error: "invalid or duplicate engine id" }, { status: 400 })
      }
      const nextCustom = [...custom, id]
      patch.customEngineIds = nextCustom
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
        if (state.lastSelectedVendor === id) patch.lastSelectedVendor = "claude"
      }
    }

    if (Object.keys(patch).length > 0) patchStateFile(patch)
    return settingsSnapshot()
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
  }
}

async function sessionResponse(req: Request, link: BridgeLink): Promise<Response> {
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
  link: BridgeLink,
  spec: (link: BridgeLink, taskId: string) => Promise<{ cwd: string; command: string[] }>,
): Promise<Response> {
  try {
    const taskId = url.searchParams.get("taskId")
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await spec(link, taskId))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

/**
 * The bridge's full HTTP route table as one (req) → Response function,
 * decoupled from `Bun.serve` and the live socket so the whole surface — the
 * RPC allowlist + teardown hook, the SSE snapshot/fan-out, the spec/engine/
 * theme/history routes, and the static fallthrough — is unit-testable against
 * a fake link. `createBridgeServer` wraps this; tests call it directly.
 */
export function createRequestHandler(deps: RequestHandlerDeps): (req: Request) => Promise<Response> {
  const { link, sseSends, staticDir } = deps
  const tearDown = deps.tearDownSession ?? ((taskId: string) => void tearDownTaskSession(taskId))
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === WEB_HEALTH_PATH) return new Response(WEB_HEALTH_MARKER)
    if (!originAllowed(req, deps.allowedHost)) {
      return new Response("forbidden: cross-origin request rejected", { status: 403 })
    }
    if (url.pathname === "/events") {
      return sseResponse((send) => {
        send("snapshot", link.snapshot())
        sseSends.add(send)
        return () => {
          sseSends.delete(send)
        }
      })
    }
    if (url.pathname === "/api/rpc" && req.method === "POST") return rpcResponse(req, link, tearDown)
    if (url.pathname === "/api/session" && req.method === "POST") return sessionResponse(req, link)
    if (url.pathname === "/api/engine-spec" && req.method === "GET") return specResponse(url, link, engineSpec)
    if (url.pathname === "/api/terminal-spec" && req.method === "GET")
      return specResponse(url, link, terminalSpec)
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

/** state.json keys for the board quick-action prompt TEMPLATES (the
 *  user-editable half — kobe's clauses are appended client-side and are
 *  not stored). Host-side so the TUI and any future surface share them. */
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

async function pidsOnPort(port: number): Promise<number[]> {
  try {
    const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const out = await new Response(proc.stdout).text()
    return out
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n !== process.pid)
  } catch {
    return []
  }
}

export async function takeoverPort(port: number, healthPath: string = WEB_HEALTH_PATH): Promise<void> {
  let body: string
  try {
    const res = await fetch(`http://localhost:${port}${healthPath}`, {
      signal: AbortSignal.timeout(800),
    })
    body = (await res.text()).trim()
  } catch {
    return
  }
  if (body !== WEB_HEALTH_MARKER) {
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
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function createBridgeServer(opts: BridgeServerOptions = {}): Promise<BridgeServer> {
  const port = opts.port ?? 5173
  const staticDir = opts.staticDir ? normalize(opts.staticDir) : undefined
  // Free the port BEFORE dialing the daemon: on an upgrade path the previous
  // holder can be an old daemon-hosted kobe-web (the pre-bridge layout) —
  // killing it first means the daemon spawned below is already the new build.
  if (opts.takeover !== false) await takeoverPort(port)

  const link = new DaemonLink()
  await link.start()

  // One bridge-level fan-out: every open SSE stream gets channel pushes, and
  // a daemon connect/disconnect transition re-sends the full snapshot (the
  // SPA reads `connected` from it — that's how the dashboard shows "daemon
  // down" while the bridge itself stays up).
  const sseSends = new Set<SseSend>()
  link.onEvent((event) => {
    for (const send of sseSends) send("channel", event)
  })
  link.onConnection(() => {
    for (const send of sseSends) send("snapshot", link.snapshot())
  })

  // Bind loopback by default so the dashboard is never exposed on all
  // interfaces (Bun.serve defaults to 0.0.0.0). KOBE_WEB_HOST overrides for the
  // rare deliberate LAN case. localhost browsers + the Vite proxy reach
  // 127.0.0.1 fine, so this is invisible in normal use.
  const hostname = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
  // When deliberately bound to a LAN host, that host's Origin must pass the
  // cross-origin guard too (loopback is always allowed); a loopback bind needs
  // no extra allowance.
  const allowedHost = LOCAL_ORIGIN.test(`http://${hostname}`) ? undefined : hostname
  const handle = createRequestHandler({ link, sseSends, staticDir, allowedHost })
  const server = Bun.serve({ port, hostname, idleTimeout: 0, fetch: handle })

  return {
    port: server.port ?? port,
    close() {
      server.stop(true)
      link.close()
    },
  }
}
