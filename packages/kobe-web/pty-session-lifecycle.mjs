/**
 * PTY session lifecycle manager for the web sidecar.
 *
 * The HTTP/WebSocket server is transport glue; this module owns the deeper
 * lifecycle state for tab-keyed PTY sessions: single-flight spawn, attach,
 * scrollback replay, resize/input, close, process-exit cleanup, and shutdown.
 */

const DEFAULT_SUBMIT_DELAYS = {
  spawnedPasteMs: 2500,
  existingPasteMs: 0,
  enterMs: 150,
}

export function createPtySessionManager({
  fetchSpec,
  spawnPty,
  createScrollback,
  scrollbackCap,
  env,
  setTimeoutFn = setTimeout,
  submitDelays = DEFAULT_SUBMIT_DELAYS,
}) {
  /** @type {Map<string, { pty: any, scrollback: ReturnType<createScrollback>, sockets: Set<any> }>} */
  const sessions = new Map()
  /** @type {Map<string, Promise<any>>} */
  const pendingSpawns = new Map()

  function spawnSession(tabId, spec, cols, rows) {
    const [cmd, ...args] = spec.command
    const spawnEnv = typeof env === "function" ? env() : env
    const pty = spawnPty(cmd, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: spec.cwd,
      env: spawnEnv,
    })
    const entry = {
      pty,
      scrollback: createScrollback(scrollbackCap),
      sockets: new Set(),
    }
    pty.onData((data) => {
      entry.scrollback.push(data)
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
    })
    pty.onExit(() => {
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) ws.close(1000, "engine exited")
      }
      if (sessions.get(tabId) === entry) sessions.delete(tabId)
    })
    sessions.set(tabId, entry)
    return entry
  }

  async function ensureSession(tabId, taskId, mode, cols, rows) {
    const existing = sessions.get(tabId)
    if (existing) return existing
    const inflight = pendingSpawns.get(tabId)
    if (inflight) return inflight
    const p = (async () => {
      const spec = await fetchSpec(taskId, mode)
      return sessions.get(tabId) ?? spawnSession(tabId, spec, cols, rows)
    })()
    pendingSpawns.set(tabId, p)
    try {
      return await p
    } finally {
      pendingSpawns.delete(tabId)
    }
  }

  function safePty(tabId, entry, fn) {
    if (sessions.get(tabId) !== entry) return
    try {
      fn(entry.pty)
    } catch {
      /* engine died — its onExit closes sockets and clears the entry */
    }
  }

  async function attachSocket({ ws, tabId, taskId, mode, cols, rows }) {
    const entry = await ensureSession(tabId, taskId, mode, cols, rows)
    const replay = entry.scrollback.length() > 0 ? entry.scrollback.replay() : ""
    entry.sockets.add(ws)
    if (replay && ws.readyState === ws.OPEN) ws.send(replay)
    safePty(tabId, entry, (pty) => pty.resize(cols, rows))

    ws.on("message", (raw) => {
      const text = raw.toString()
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text)
          if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
            safePty(tabId, entry, (pty) => pty.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0)))
            return
          }
        } catch {
          /* fall through to raw write */
        }
      }
      safePty(tabId, entry, (pty) => pty.write(text))
    })

    ws.on("close", () => {
      entry.sockets.delete(ws)
    })

    return entry
  }

  function closeSession(tabId) {
    const entry = sessions.get(tabId)
    if (!entry) return false
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    if (sessions.get(tabId) === entry) sessions.delete(tabId)
    return true
  }

  async function sendText({ tabId, taskId, text }) {
    let entry = sessions.get(tabId)
    let spawned = false
    if (!entry && taskId) {
      entry = await ensureSession(tabId, taskId, "engine", 80, 24)
      spawned = true
    }
    if (!entry) return { sent: false, spawned: false, missing: true }

    const target = entry
    const pasteDelay = spawned ? submitDelays.spawnedPasteMs : submitDelays.existingPasteMs
    setTimeoutFn(() => {
      try {
        target.pty.write(`\x1b[200~${text}\x1b[201~`)
      } catch {
        return
      }
      setTimeoutFn(() => {
        try {
          target.pty.write("\r")
        } catch {
          /* best-effort */
        }
      }, submitDelays.enterMs)
    }, pasteDelay)
    return { sent: true, spawned }
  }

  function shutdown() {
    for (const entry of sessions.values()) {
      try {
        entry.pty.kill()
      } catch {
        /* ignore */
      }
    }
    sessions.clear()
    pendingSpawns.clear()
  }

  return {
    attachSocket,
    closeSession,
    ensureSession,
    sendText,
    shutdown,
    sessionCount: () => sessions.size,
    pendingSpawnCount: () => pendingSpawns.size,
  }
}
