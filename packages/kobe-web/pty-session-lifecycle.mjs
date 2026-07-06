
const DEFAULT_SUBMIT_DELAYS = {
  spawnedPasteMs: 2500,
  existingPasteMs: 0,
  enterMs: 150,
}

const DEFAULT_MAX_SESSIONS = 64

const DEFAULT_BACKPRESSURE = {
  highWaterBytes: 1 << 20,
  lowWaterBytes: 1 << 18,
  drainPollMs: 50,
}

export function pickEvictableTab(sessions) {
  for (const [tabId, entry] of sessions) {
    if (entry.sockets.size === 0) return tabId
  }
  return null
}

export function shouldPausePty(sockets, highWaterBytes) {
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount > highWaterBytes) {
      return true
    }
  }
  return false
}

export function shouldResumePty(sockets, lowWaterBytes) {
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount > lowWaterBytes) {
      return false
    }
  }
  return true
}

export function createPtySessionManager({
  fetchSpec,
  spawnPty,
  createScrollback,
  scrollbackCap,
  env,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  submitDelays = DEFAULT_SUBMIT_DELAYS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  backpressure = DEFAULT_BACKPRESSURE,
}) {
  const sessions = new Map()
  const pendingSpawns = new Map()

  function applyBackpressure(entry) {
    if (entry.paused) return
    if (!shouldPausePty(entry.sockets, backpressure.highWaterBytes)) return
    entry.paused = true
    try {
      entry.pty.pause?.()
    } catch {
    }
    if (entry.drainTimer !== null) return
    entry.drainTimer = setIntervalFn(() => {
      if (!shouldResumePty(entry.sockets, backpressure.lowWaterBytes)) return
      clearDrainTimer(entry)
      entry.paused = false
      try {
        entry.pty.resume?.()
      } catch {
      }
    }, backpressure.drainPollMs)
  }

  function clearDrainTimer(entry) {
    if (entry.drainTimer !== null) {
      clearIntervalFn(entry.drainTimer)
      entry.drainTimer = null
    }
  }

  function spawnSession(tabId, spec, cols, rows) {
    if (sessions.size >= maxSessions && !sessions.has(tabId)) {
      const victim = pickEvictableTab(sessions)
      if (victim === null) {
        throw new Error(`pty session limit reached (${maxSessions})`)
      }
      closeSession(victim)
    }
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
      paused: false,
      drainTimer: null,
    }
    pty.onData((data) => {
      entry.scrollback.push(data)
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) ws.send(data)
      }
      applyBackpressure(entry)
    })
    pty.onExit(() => {
      clearDrainTimer(entry)
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
    clearDrainTimer(entry)
    try {
      entry.pty.kill()
    } catch {
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
        }
      }, submitDelays.enterMs)
    }, pasteDelay)
    return { sent: true, spawned }
  }

  function shutdown() {
    for (const entry of sessions.values()) {
      clearDrainTimer(entry)
      try {
        entry.pty.kill()
      } catch {
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
