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

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { execFile } from "node:child_process"
import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node-pty"
import { WebSocketServer } from "ws"
import { createEngineSessionObservationClient } from "./engine-session-observer.mjs"
import { allowedHostForBindHost, originAllowed } from "./origin-policy.mjs"
import { ptyEnv } from "./pty-env.mjs"
import { createScrollback } from "./pty-scrollback.mjs"
import { createPtySessionManager } from "./pty-session-lifecycle.mjs"

const PORT = Number.parseInt(process.env.KOBE_PTY_PORT ?? "5175", 10)
const DAEMON_WEB_PORT = Number.parseInt(process.env.KOBE_DAEMON_WEB_PORT ?? "5174", 10)
const SCROLLBACK_CAP = 256 * 1024 // bytes of recent output replayed on (re)attach
const HEALTH_PATH = "/__kobe_web"
const HEALTH_MARKER = "kobe-web"
const HOST = process.env.KOBE_WEB_HOST?.trim() || "127.0.0.1"
const ALLOWED_HOST = allowedHostForBindHost(HOST)
const sessionObserver = createEngineSessionObservationClient({ daemonWebPort: DAEMON_WEB_PORT })

const CLAUDE_HOME = join(homedir(), ".claude")
const IMG_MIMES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

/** The `<session>.jsonl` transcript under a ~/.claude/projects subdir (the
 *  file is named by session id; the project dir varies by cwd). */
function findTranscript(session) {
  const base = join(CLAUDE_HOME, "projects")
  if (!existsSync(base)) return null
  for (const proj of readdirSync(base)) {
    const p = join(base, proj, `${session}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}

/** The Nth (1-based, global order) pasted image across all user messages in a
 *  transcript — this is the source of truth for a SENT `[Image #N]`, since the
 *  image-cache file is deleted once the turn is processed. Only top-level
 *  `image` blocks count (tool_result images are skipped). */
function nthTranscriptImage(transcriptPath, n) {
  let count = 0
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.includes('"image"')) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    if (!Array.isArray(content)) continue
    for (const blk of content) {
      if (blk?.type !== "image" || !blk?.source?.data) continue
      count += 1
      if (count === n)
        return { data: blk.source.data, mime: blk.source.media_type }
    }
  }
  return null
}

async function fetchSpec(taskId, mode, vendor, tabId) {
  // e2e/dev harness override: run an arbitrary TUI (dev:mock / dev:sandbox) in
  // the PTY instead of resolving a task's engine via the daemon — so a Playwright
  // test can drive the real TUI through the web terminal with no daemon or task.
  if (process.env.KOBE_PTY_DEV_COMMAND) {
    return {
      cwd: process.env.KOBE_PTY_DEV_CWD ?? process.cwd(),
      command: ["/bin/sh", "-lc", process.env.KOBE_PTY_DEV_COMMAND],
    }
  }
  const path = mode === "shell" ? "/api/terminal-spec" : "/api/engine-spec"
  let url = `http://localhost:${DAEMON_WEB_PORT}${path}?taskId=${encodeURIComponent(taskId)}`
  if (mode === "engine" && vendor) url += `&vendor=${encodeURIComponent(vendor)}`
  // Tab identity → KOBE_TAB_ID (engine export line / shell env), so hooks
  // attribute events per tab — including a manual `claude` typed in a shell.
  if (tabId) url += `&tab=${encodeURIComponent(tabId)}`
  const res = await fetch(url)
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
  onTerminalCommit: sessionObserver.observe,
})

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === HEALTH_PATH) {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end(HEALTH_MARKER)
    return
  }
  // Serve the real bytes for a `[Image #N]` so /chat shows the thumbnail.
  // Two sources: the live image-cache file (~/.claude/image-cache/<session>/
  // <N>.<ext>) that exists only while composing, and — once sent — the base64
  // block in the session transcript (the cache file is deleted after the turn).
  // If neither is there the front-end keeps the `[Image #N]` chip. Strict
  // allowlist on both params — no path traversal.
  if (req.method === "GET" && url.pathname === "/image") {
    const session = url.searchParams.get("session") ?? ""
    const n = url.searchParams.get("n") ?? ""
    if (!/^[a-f0-9-]{36}$/.test(session) || !/^\d+$/.test(n)) {
      res.writeHead(400)
      res.end("bad request")
      return
    }
    const headers = {
      "access-control-allow-origin": "*",
      "cache-control": "private, max-age=60",
    }
    // 1) Live compose: the staged cache file.
    const dir = join(CLAUDE_HOME, "image-cache", session)
    for (const [ext, mime] of Object.entries(IMG_MIMES)) {
      const p = join(dir, `${n}${ext}`)
      if (existsSync(p)) {
        res.writeHead(200, { ...headers, "content-type": mime })
        createReadStream(p).pipe(res)
        return
      }
    }
    // 2) Sent history: the base64 block in the transcript.
    const transcript = findTranscript(session)
    const img = transcript ? nthTranscriptImage(transcript, Number(n)) : null
    if (img) {
      res.writeHead(200, {
        ...headers,
        "content-type": img.mime ?? "image/png",
      })
      res.end(Buffer.from(img.data, "base64"))
      return
    }
    res.writeHead(404)
    res.end("not found")
    return
  }
  // GET /pty/foreground → { [tabId]: comm[] } — every live descendant of each
  // session's shell (one bounded ps walk). The TUI live-engine mirror
  // (engine/foreground.ts): a tab whose process tree contains an engine binary
  // renders as that vendor in the sidebar. Read-only process names; the
  // engine-id matching stays client-side (engine-owned data).
  if (req.method === "GET" && url.pathname === "/pty/foreground") {
    execFile("ps", ["-axo", "pid=,ppid=,comm="], (err, stdout) => {
      const byParent = new Map()
      if (!err) {
        for (const line of String(stdout).split("\n")) {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
          if (!m) continue
          const list = byParent.get(Number(m[2])) ?? []
          list.push({ pid: Number(m[1]), comm: m[3].trim() })
          byParent.set(Number(m[2]), list)
        }
      }
      const out = {}
      for (const { tabId, pid } of ptySessions.listSessions()) {
        const comms = []
        const queue = [pid]
        while (queue.length > 0 && comms.length < 50) {
          for (const kid of byParent.get(queue.shift()) ?? []) {
            comms.push(kid.comm.split("/").pop())
            queue.push(kid.pid)
          }
        }
        out[tabId] = comms
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      })
      res.end(JSON.stringify(out))
    })
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
      if (tab) sessionObserver.forget(tab)
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
  const vendor = url.searchParams.get("vendor") ?? undefined

  if (!tabId || !taskId) {
    ws.close(1008, "missing tab/taskId")
    return
  }

  void (async () => {
    try {
      // Single-flight spawn: concurrent attaches for this tab share one PTY.
      await ptySessions.attachSocket({ ws, tabId, taskId, mode, cols, rows, vendor })
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
