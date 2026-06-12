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
 *   GET  /api/engines         engine-owned vendor list (id + display label)
 *   *    /api/notes, /api/diff, /api/issues  bridge-local (filesystem) routes
 *   *                         static SPA fallthrough when `staticDir` is set
 */

import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { availableEngineIds } from "../../kobe/src/engine/account-detect.ts"
import { engineDisplayName } from "../../kobe/src/engine/interactive-command.ts"
import { getPersistedString, setPersistedString } from "../../kobe/src/state/repos.ts"
import { handleDiffRequest } from "../../kobe/src/web/diff.ts"
import { handleHistoryRequest } from "../../kobe/src/web/history.ts"
import { handleIssuesRequest } from "../../kobe/src/web/issues.ts"
import { handleNotesRequest } from "../../kobe/src/web/notes.ts"
import { handleThemesRequest } from "../../kobe/src/web/themes.ts"
import { DaemonLink } from "./daemon-link.ts"
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
 *  engines, labeled with their (possibly user-overridden) display names —
 *  so the SPA never hard-codes vendor strings (CLAUDE.md: engine-owned UI
 *  data). Falls back to the always-shippable claude entry on probe failure. */
async function enginesResponse(): Promise<Response> {
  try {
    const ids = await availableEngineIds()
    const engines = ids.map((id) => ({ id, label: engineDisplayName(id) }))
    return Response.json({ engines: engines.length > 0 ? engines : [{ id: "claude", label: "Claude" }] })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
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
    if (url.pathname === "/api/quick-prompts" && req.method === "GET") return quickPromptsGet()
    if (url.pathname === "/api/quick-prompts" && req.method === "PUT") return quickPromptsPut(req)
    const notes = await handleNotesRequest(req, url)
    if (notes) return notes
    const diff = await handleDiffRequest(req, url)
    if (diff) return diff
    const history = await handleHistoryRequest(req, url)
    if (history) return history
    const issues = await handleIssuesRequest(req, url)
    if (issues) return issues
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

  const handle = createRequestHandler({ link, sseSends, staticDir })
  // Bind loopback by default so the dashboard is never exposed on all
  // interfaces (Bun.serve defaults to 0.0.0.0). KOBE_WEB_HOST overrides for the
  // rare deliberate LAN case. localhost browsers + the Vite proxy reach
  // 127.0.0.1 fine, so this is invisible in normal use.
  const hostname = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
  const server = Bun.serve({ port, hostname, idleTimeout: 0, fetch: handle })

  return {
    port: server.port ?? port,
    close() {
      server.stop(true)
      link.close()
    },
  }
}
