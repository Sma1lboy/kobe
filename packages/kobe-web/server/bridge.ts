
import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { availableEngineIds } from "../../kobe/src/engine/account-detect.ts"
import { engineDisplayName, kobeApiInvocation } from "../../kobe/src/engine/interactive-command.ts"
import { engineEntry } from "../../kobe/src/engine/registry.ts"
import { getPersistedString, getSavedRepos, setPersistedString } from "../../kobe/src/state/repos.ts"
import { handleDiffRequest } from "../../kobe/src/web/diff.ts"
import { handleHistoryRequest } from "../../kobe/src/web/history.ts"
import { handleNotesRequest } from "../../kobe/src/web/notes.ts"
import { handleThemesRequest } from "../../kobe/src/web/themes.ts"
import { allowedHostForBindHost, originAllowed } from "../origin-policy.mjs"
import { settingsPatch, settingsSnapshot } from "./bridge-settings.ts"
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

export interface BridgeLink extends DaemonRpcClient {
  snapshot(): unknown
}

export interface RequestHandlerDeps {
  link: BridgeLink
  sseSends: Set<SseSend>
  staticDir?: string
  tearDownSession?: (taskId: string) => void
  allowedHost?: string
}

function sseResponse(register: (send: SseSend) => () => void, signal?: AbortSignal): Response {
  let unregister: (() => void) | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    if (heartbeat) clearInterval(heartbeat)
    unregister?.()
  }
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const send: SseSend = (type, data) => {
        try {
          controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
        }
      }
      unregister = register(send)
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": ping\n\n"))
        } catch {
          cleanup()
        }
      }, 15_000)
      if (signal?.aborted) cleanup()
      else signal?.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      cleanup()
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
    const taskId = (payload as { taskId?: unknown } | undefined)?.taskId
    if (typeof taskId === "string") {
      const archiving =
        name === "task.archive" && (payload as { archived?: unknown }).archived !== false
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

export function createRequestHandler(deps: RequestHandlerDeps): (req: Request) => Promise<Response> {
  const { link, sseSends, staticDir } = deps
  const tearDown = deps.tearDownSession ?? ((taskId: string) => void tearDownTaskSession(taskId))
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === WEB_HEALTH_PATH) return new Response(WEB_HEALTH_MARKER)
    if (!originAllowed(req.headers.get("origin"), { allowedHost: deps.allowedHost })) {
      return new Response("forbidden: cross-origin request rejected", { status: 403 })
    }
    if (url.pathname === "/events") {
      return sseResponse((send) => {
        send("snapshot", link.snapshot())
        sseSends.add(send)
        return () => {
          sseSends.delete(send)
        }
      }, req.signal)
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
  if (opts.takeover !== false) await takeoverPort(port)

  const link = new DaemonLink()
  await link.start()

  const sseSends = new Set<SseSend>()
  link.onEvent((event) => {
    for (const send of sseSends) send("channel", event)
  })
  link.onConnection(() => {
    for (const send of sseSends) send("snapshot", link.snapshot())
  })

  const hostname = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
  const allowedHost = allowedHostForBindHost(hostname)
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
