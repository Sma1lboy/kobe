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
 *   POST /api/rpc             forward a daemon RPC by name
 *   POST /api/session         ensure a task's tmux session exists
 *   GET  /api/engine-spec     PTY launch spec for a task's engine tab
 *   GET  /api/terminal-spec   PTY launch spec for a task's shell tab
 *   *    /api/notes, /api/diff  bridge-local (filesystem) routes
 *   *                         static SPA fallthrough when `staticDir` is set
 */

import { existsSync } from "node:fs"
import { join, normalize } from "node:path"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { handleDiffRequest } from "../../kobe/src/web/diff.ts"
import { handleNotesRequest } from "../../kobe/src/web/notes.ts"
import { DaemonLink } from "./daemon-link.ts"
import { engineSpec, ensureTaskSession, terminalSpec } from "./session.ts"

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

async function rpcResponse(req: Request, link: DaemonLink): Promise<Response> {
  try {
    const { name, payload } = (await req.json()) as { name?: DaemonRequestName; payload?: unknown }
    if (!name) return Response.json({ error: "missing rpc name" }, { status: 400 })
    if (name === "hello" || name === "subscribe" || name === "daemon.stop") {
      throw new Error(`rpc ${name} is not exposed to the web UI`)
    }
    const result = await link.request(name, payload)
    return Response.json({ result })
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

async function sessionResponse(req: Request, link: DaemonLink): Promise<Response> {
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
  link: DaemonLink,
  spec: (link: DaemonLink, taskId: string) => Promise<{ cwd: string; command: string[] }>,
): Promise<Response> {
  try {
    const taskId = url.searchParams.get("taskId")
    if (!taskId) return Response.json({ error: "missing taskId" }, { status: 400 })
    return Response.json(await spec(link, taskId))
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
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

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
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
      if (url.pathname === "/api/rpc" && req.method === "POST") return rpcResponse(req, link)
      if (url.pathname === "/api/session" && req.method === "POST") return sessionResponse(req, link)
      if (url.pathname === "/api/engine-spec" && req.method === "GET") return specResponse(url, link, engineSpec)
      if (url.pathname === "/api/terminal-spec" && req.method === "GET") return specResponse(url, link, terminalSpec)
      const notes = await handleNotesRequest(req, url)
      if (notes) return notes
      const diff = await handleDiffRequest(req, url)
      if (diff) return diff
      if (staticDir) return staticResponse(url.pathname, staticDir)
      return new Response("not found", { status: 404 })
    },
  })

  return {
    port: server.port ?? port,
    close() {
      server.stop(true)
      link.close()
    },
  }
}
