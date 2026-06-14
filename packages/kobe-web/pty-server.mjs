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
 *   POST /pty/send    { tab, taskId, text }            paste text + Enter into the tab's engine
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

// In-flight spawns, keyed by tabId. `fetchSpec` is async, so a naive
// check-then-`spawnTab` lets two concurrent attaches for the SAME tab (React
// StrictMode double-mount, a fast reconnect racing the first attach, or a
// board /pty/send racing a WS open) both pass the `!entry` check and both
// spawn — the second `tabs.set` orphans the first PTY (no longer in `tabs`, so
// /pty/close and shutdown can never kill it, and its onExit deletes the live
// entry's mapping). Coalescing onto one promise per tabId makes spawn
// single-flight, so concurrent attaches share exactly one PTY.
const pendingSpawns = new Map()

async function ensureTab(tabId, taskId, mode, cols, rows) {
  const existing = tabs.get(tabId)
  if (existing) return existing
  const inflight = pendingSpawns.get(tabId)
  if (inflight) return inflight
  const p = (async () => {
    const spec = await fetchSpec(taskId, mode)
    // A prior spawn may have completed (and not yet been closed) while we
    // awaited the spec — reuse it rather than spawning a duplicate.
    return tabs.get(tabId) ?? spawnTab(tabId, spec, cols, rows)
  })()
  pendingSpawns.set(tabId, p)
  try {
    return await p
  } finally {
    pendingSpawns.delete(tabId)
  }
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
  if (req.method === "POST" && url.pathname === "/pty/send") {
    // Sending text DRIVES the engine like a keyboard, so unlike /pty/close
    // (best-effort kill) this holds the same origin policy as the WS attach:
    // localhost pages or non-browser clients only.
    const origin = req.headers.origin
    if (origin && !LOCAL_ORIGIN.test(origin)) {
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
      let entry = tabs.get(tab)
      let spawned = false
      if (!entry && typeof taskId === "string" && taskId) {
        // Spawn-on-send: a board action can fire without the terminal ever
        // opening — output lands in the scrollback ring for the next attach.
        // ensureTab coalesces with any concurrent WS attach for the same tab.
        try {
          entry = await ensureTab(tab, taskId, "engine", 80, 24)
          spawned = true
        } catch (err) {
          respond(500, { sent: false, error: `failed to start engine: ${err?.message ?? err}` })
          return
        }
      }
      if (!entry) {
        respond(404, { sent: false, error: "no such tab" })
        return
      }
      // Same submit contract as the composer / tmux pasteAndSubmit:
      // bracketed paste so a multi-line prompt arrives as ONE paste, then
      // Enter. A freshly spawned engine gets a grace delay so the paste
      // isn't eaten by its startup. The Enter MUST land in a separate,
      // later write: written back-to-back it coalesces into the same tty
      // chunk as the paste and claude treats it as paste content — the
      // text sits in the composer and never submits. (tmux pasteAndSubmit
      // gets this separation for free from its two commands; the web
      // composer from its two WS messages.)
      const target = entry
      setTimeout(
        () => {
          try {
            target.pty.write(`\x1b[200~${text}\x1b[201~`)
          } catch {
            /* engine died between spawn and paste — next attach shows why */
            return
          }
          setTimeout(() => {
            try {
              target.pty.write("\r")
            } catch {
              /* same: best-effort */
            }
          }, 150)
        },
        spawned ? 2500 : 0,
      )
      respond(200, { sent: true, spawned })
    })
    return
  }
  if (req.method === "POST" && url.pathname === "/pty/close") {
    // Killing a tab is a side effect a cross-origin local page could abuse to
    // DoS the session (tab ids are client-generated/observable), so hold the
    // same origin policy as /pty/send and the WS attach: localhost pages or
    // non-browser clients (no Origin) only.
    const origin = req.headers.origin
    if (origin && !LOCAL_ORIGIN.test(origin)) {
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

// A PTY WS is arbitrary command exec in the worktree, so reject cross-origin
// upgrades: a browser sends an Origin header, and only localhost pages may
// attach (defends a malicious local page / DNS-rebinding even on the loopback
// bind). Non-browser clients (no Origin) are allowed — there's no browser to
// forge their request.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
const wss = new WebSocketServer({
  server,
  path: "/pty",
  verifyClient: ({ origin }) => !origin || LOCAL_ORIGIN.test(origin),
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
    let entry
    try {
      // Single-flight spawn: concurrent attaches for this tab share one PTY.
      entry = await ensureTab(tabId, taskId, mode, cols, rows)
    } catch (err) {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\nfailed to start ${mode}: ${err?.message ?? err}\r\n`)
        ws.close(1011, "spawn failed")
      }
      return
    }

    entry.sockets.add(ws)
    // Replay recent output so a (re)attach shows current screen state.
    if (entry.scrollback.length() > 0 && ws.readyState === ws.OPEN) ws.send(entry.scrollback.replay())
    // The PTY can exit between spawn/attach and any op below; node-pty throws
    // on resize/write against a dead handle, and this sidecar has no
    // uncaughtException net (unlike the daemon) — an unguarded throw in a `ws`
    // callback kills the whole pty-server process. Guard every pty op.
    const safePty = (fn) => {
      if (!tabs.has(tabId)) return
      try {
        fn(entry.pty)
      } catch {
        /* engine died — its onExit already closed the sockets */
      }
    }
    safePty((pty) => pty.resize(cols, rows))

    ws.on("message", (raw) => {
      const text = raw.toString()
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            safePty((pty) => pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)))
            return
          }
        } catch {
          /* fall through to raw write */
        }
      }
      safePty((pty) => pty.write(text))
    })

    ws.on("close", () => {
      entry.sockets.delete(ws)
      // Keep the PTY alive for reconnects; it's killed only via /pty/close.
    })
  })()
})

// Bind loopback by default — a PTY is an arbitrary shell/engine in the
// worktree, so it must never listen on all interfaces. KOBE_WEB_HOST overrides.
const HOST = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
server.listen(PORT, HOST, () => {
  process.stdout.write(`kobe pty-server listening on ${HOST}:${PORT} (bridge :${BRIDGE_PORT})\n`)
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
