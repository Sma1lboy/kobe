/**
 * PTY server — the node half of the web terminal (node-pty doesn't work under
 * bun, so the live terminals run here as a separate node process).
 *
 * Model: each web PTY tab is identified by a client-generated `tab` id. Its
 * PTY is spawned lazily on first attach (launch spec fetched from daemon web
 * transport by taskId + mode) and kept alive across WebSocket reconnects, so a
 * page refresh re-attaches to the same process. Closing a tab (POST
 * /pty/close) kills its PTY.
 *
 *   ws  /pty?tab=<id>&taskId=<id>&mode=engine|shell&cols=<n>&rows=<n>
 *   POST /pty/close   { tab }                          kill the tab process
 *   POST /pty/send    { tab, taskId, text }            paste text + Enter into the tab's engine
 */

import { createServer } from "node:http"
import { spawn } from "node-pty"
import { WebSocketServer } from "ws"
import { allowedHostForBindHost, originAllowed } from "./origin-policy.mjs"
import { createScrollback } from "./pty-scrollback.mjs"
import { createPtySessionManager } from "./pty-session-lifecycle.mjs"

const PORT = Number.parseInt(process.env.KOBE_PTY_PORT ?? "5175", 10)
const DAEMON_WEB_PORT = Number.parseInt(process.env.KOBE_DAEMON_WEB_PORT ?? "5174", 10)
const SCROLLBACK_CAP = 256 * 1024 // bytes of recent output replayed on (re)attach
const HEALTH_PATH = "/__kobe_web"
const HEALTH_MARKER = "kobe-web"
const HOST = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
const ALLOWED_HOST = allowedHostForBindHost(HOST)

function ptyEnv() {
  const { NO_COLOR: _noColor, ...env } = process.env
  // Codex/CI shells often set NO_COLOR=1. The browser PTY is a real terminal
  // surface, so don't let the launcher process accidentally turn off colors in
  // Claude, Codex, shells, or common CLI tools.
  env.CLICOLOR = env.CLICOLOR ?? "1"
  env.COLORTERM = env.COLORTERM || "truecolor"
  return env
}

async function fetchSpec(taskId, mode) {
  const path = mode === "shell" ? "/api/terminal-spec" : "/api/engine-spec"
  const res = await fetch(`http://localhost:${DAEMON_WEB_PORT}${path}?taskId=${encodeURIComponent(taskId)}`)
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(json.error ?? `engine-spec failed (${res.status})`)
  return json // { cwd, command: string[] }
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
    // Sending text DRIVES the engine like a keyboard, so unlike /pty/close
    // (best-effort kill) this holds the same origin policy as the WS attach:
    // localhost pages or non-browser clients only.
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
        /* ignore */
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
        // Spawn-on-send: a board action can fire without the terminal ever
        // opening — output lands in the scrollback ring for the next attach.
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
    // Killing a tab is a side effect a cross-origin local page could abuse to
    // DoS the session (tab ids are client-generated/observable), so hold the
    // same origin policy as /pty/send and the WS attach: localhost pages or
    // non-browser clients (no Origin) only.
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
        /* ignore */
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

// A PTY WS is arbitrary command exec in the worktree, so reject cross-origin
// upgrades: a browser sends an Origin header, and only loopback pages (or the
// deliberately configured LAN host) may attach. This defends a malicious local
// page / DNS-rebinding even on the loopback bind. Non-browser clients (no
// Origin) are allowed — there's no browser to forge their request.
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
      // Single-flight spawn: concurrent attaches for this tab share one PTY.
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

// Bind loopback by default — a PTY is an arbitrary shell/engine in the
// worktree, so it must never listen on all interfaces. KOBE_WEB_HOST overrides.
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
