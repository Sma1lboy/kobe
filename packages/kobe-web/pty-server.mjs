/**
 * PTY server — the node half of the web terminal (node-pty doesn't work under
 * bun, so the live terminals run here as a separate node process).
 *
 * Model: each web PTY tab is identified by a client-generated `tab` id. Its
 * PTY is spawned lazily on first attach (launch spec fetched from the bun
 * bridge by taskId + mode) and kept alive across WebSocket reconnects, so a
 * page refresh re-attaches to the same process. Closing a tab (POST
 * /pty/close) kills its PTY.
 *
 *   ws  /pty?tab=<id>&taskId=<id>&mode=engine|shell&cols=<n>&rows=<n>
 *   POST /pty/close   { tab }                          kill the tab process
 */

import { createServer } from "node:http"
import { spawn } from "node-pty"
import { WebSocketServer } from "ws"
import { createScrollback } from "./pty-scrollback.mjs"

const PORT = Number.parseInt(process.env.KOBE_PTY_PORT ?? "5175", 10)
const BRIDGE_PORT = Number.parseInt(process.env.KOBE_BRIDGE_PORT ?? "5174", 10)
const SCROLLBACK_CAP = 256 * 1024 // bytes of recent output replayed on (re)attach
const HEALTH_PATH = "/__kobe_web"
const HEALTH_MARKER = "kobe-web"

/** tabId → { pty, buffer, sockets } */
const tabs = new Map()

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
  const res = await fetch(`http://localhost:${BRIDGE_PORT}${path}?taskId=${encodeURIComponent(taskId)}`)
  const json = await res.json()
  if (!res.ok || json.error) throw new Error(json.error ?? `engine-spec failed (${res.status})`)
  return json // { cwd, command: string[] }
}

function spawnTab(tabId, spec, cols, rows) {
  const [cmd, ...args] = spec.command
  const pty = spawn(cmd, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: spec.cwd,
    env: ptyEnv(),
  })
  // Scrollback is a bounded ring of chunks, not a single growing string: the
  // old `(buffer + data).slice(-CAP)` re-flattened ~256KB on EVERY chunk once
  // the cap was reached (quadratic during heavy streaming). `push` is O(chunk);
  // the string is materialized only on (re)attach replay.
  const entry = { pty, scrollback: createScrollback(SCROLLBACK_CAP), sockets: new Set() }
  pty.onData((data) => {
    entry.scrollback.push(data)
    for (const ws of entry.sockets) if (ws.readyState === ws.OPEN) ws.send(data)
  })
  pty.onExit(() => {
    for (const ws of entry.sockets) if (ws.readyState === ws.OPEN) ws.close(1000, "engine exited")
    tabs.delete(tabId)
  })
  tabs.set(tabId, entry)
  return entry
}

function closeTab(tabId) {
  const entry = tabs.get(tabId)
  if (!entry) return false
  try {
    entry.pty.kill()
  } catch {
    /* already gone */
  }
  tabs.delete(tabId)
  return true
}

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
  if (req.method === "POST" && url.pathname === "/pty/close") {
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
      const ok = tab ? closeTab(tab) : false
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

const wss = new WebSocketServer({ server, path: "/pty" })

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
    let entry = tabs.get(tabId)
    if (!entry) {
      try {
        const spec = await fetchSpec(taskId, mode)
        entry = spawnTab(tabId, spec, cols, rows)
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(`\r\nfailed to start ${mode}: ${err?.message ?? err}\r\n`)
          ws.close(1011, "spawn failed")
        }
        return
      }
    }

    entry.sockets.add(ws)
    // Replay recent output so a (re)attach shows current screen state.
    if (entry.scrollback.length() > 0 && ws.readyState === ws.OPEN) ws.send(entry.scrollback.replay())
    entry.pty.resize(cols, rows)

    ws.on("message", (raw) => {
      const text = raw.toString()
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            entry.pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0))
            return
          }
        } catch {
          /* fall through to raw write */
        }
      }
      entry.pty.write(text)
    })

    ws.on("close", () => {
      entry.sockets.delete(ws)
      // Keep the PTY alive for reconnects; it's killed only via /pty/close.
    })
  })()
})

server.listen(PORT, () => {
  process.stdout.write(`kobe pty-server listening on :${PORT} (bridge :${BRIDGE_PORT})\n`)
})

const shutdown = () => {
  for (const [, entry] of tabs) {
    try {
      entry.pty.kill()
    } catch {
      /* ignore */
    }
  }
  wss.close()
  server.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
