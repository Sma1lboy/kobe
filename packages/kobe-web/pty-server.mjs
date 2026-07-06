
import { createServer } from "node:http"
import { spawn } from "node-pty"
import { WebSocketServer } from "ws"
import { allowedHostForBindHost, originAllowed } from "./origin-policy.mjs"
import { createScrollback } from "./pty-scrollback.mjs"
import { createPtySessionManager } from "./pty-session-lifecycle.mjs"

const PORT = Number.parseInt(process.env.KOBE_PTY_PORT ?? "5175", 10)
const DAEMON_WEB_PORT = Number.parseInt(process.env.KOBE_DAEMON_WEB_PORT ?? "5174", 10)
const SCROLLBACK_CAP = 256 * 1024
const HEALTH_PATH = "/__kobe_web"
const HEALTH_MARKER = "kobe-web"
const HOST = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
const ALLOWED_HOST = allowedHostForBindHost(HOST)

function ptyEnv() {
  const { NO_COLOR: _noColor, ...env } = process.env
  env.CLICOLOR = env.CLICOLOR ?? "1"
  env.COLORTERM = env.COLORTERM || "truecolor"
  return env
}

async function fetchSpec(taskId, mode) {
  if (process.env.KOBE_PTY_DEV_COMMAND) {
    return {
      cwd: process.env.KOBE_PTY_DEV_CWD ?? process.cwd(),
      command: ["/bin/sh", "-lc", process.env.KOBE_PTY_DEV_COMMAND],
    }
  }
  const path = mode === "shell" ? "/api/terminal-spec" : "/api/engine-spec"
  const res = await fetch(`http://localhost:${DAEMON_WEB_PORT}${path}?taskId=${encodeURIComponent(taskId)}`)
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(json.error ?? `engine-spec failed (${res.status})`)
  return json
}

const ptySessions = createPtySessionManager({
  fetchSpec,
  spawnPty: spawn,
  createScrollback,
  scrollbackCap: SCROLLBACK_CAP,
  env: ptyEnv,
})

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === HEALTH_PATH) {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(HEALTH_MARKER)
    return
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    })
    res.end()
    return
  }
  if (req.method === "POST" && url.pathname === "/pty/send") {
    if (!originAllowed(req.headers.origin, { allowedHost: ALLOWED_HOST })) {
      res.writeHead(403)
      res.end()
      return
    }
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", async () => {
      let tab
      let taskId
      let text
      try {
        ;({ tab, taskId, text } = JSON.parse(body || "{}"))
      } catch {
      }
      const respond = (status, payload) => {
        res.writeHead(status, {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        })
        res.end(JSON.stringify(payload))
      }
      if (typeof tab !== "string" || !tab || typeof text !== "string" || !text) {
        respond(400, { sent: false, error: "tab and text are required" })
        return
      }
      let result
      try {
        result = await ptySessions.sendText({
          tabId: tab,
          taskId: typeof taskId === "string" && taskId ? taskId : null,
          text,
        })
      } catch (err) {
        respond(500, { sent: false, error: `failed to start engine: ${err?.message ?? err}` })
        return
      }
      if (!result.sent) {
        respond(404, { sent: false, error: "no such tab" })
        return
      }
      respond(200, { sent: true, spawned: result.spawned })
    })
    return
  }
  if (req.method === "POST" && url.pathname === "/pty/close") {
    if (!originAllowed(req.headers.origin, { allowedHost: ALLOWED_HOST })) {
      res.writeHead(403)
      res.end()
      return
    }
    let body = ""
    req.on("data", (c) => {
      body += c
    })
    req.on("end", () => {
      let tab
      try {
        tab = JSON.parse(body || "{}").tab
      } catch {
      }
      const ok = tab ? ptySessions.closeSession(tab) : false
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      })
      res.end(JSON.stringify({ closed: ok }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({
  server,
  path: "/pty",
  verifyClient: ({ origin }) => originAllowed(origin, { allowedHost: ALLOWED_HOST }),
})

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const tabId = url.searchParams.get("tab")
  const taskId = url.searchParams.get("taskId")
  const cols = Number.parseInt(url.searchParams.get("cols") ?? "80", 10) || 80
  const rows = Number.parseInt(url.searchParams.get("rows") ?? "24", 10) || 24
  const mode = url.searchParams.get("mode") === "shell" ? "shell" : "engine"

  if (!tabId || !taskId) {
    ws.close(1008, "missing tab/taskId")
    return
  }

  void (async () => {
    try {
      await ptySessions.attachSocket({ ws, tabId, taskId, mode, cols, rows })
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\nfailed to start ${mode}: ${err?.message ?? err}\r\n`)
        ws.close(1011, "spawn failed")
      }
      return
    }
  })()
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`kobe pty-server listening on ${HOST}:${PORT} (daemon-web :${DAEMON_WEB_PORT})\n`)
})

const shutdown = () => {
  ptySessions.shutdown()
  wss.close()
  server.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
