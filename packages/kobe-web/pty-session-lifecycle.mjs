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

// A browser opening /pty?tab=<id> with ever-new tab ids would otherwise spawn
// node-pty processes without bound. Cap concurrent sessions; spawning past the
// cap evicts the oldest session with no attached sockets, and rejects when every
// session is being actively viewed.
const DEFAULT_MAX_SESSIONS = 64

// PTY→WebSocket backpressure: a flooding pty (`yes`) outruns a slow browser, so
// node buffers the unsent bytes (ws.bufferedAmount) without bound. Pause the pty
// once any socket's buffer crosses the high-water mark and resume once every
// socket has drained back under the low-water mark.
const DEFAULT_BACKPRESSURE = {
  highWaterBytes: 1 << 20, // 1 MiB queued to a socket → pause the pty
  lowWaterBytes: 1 << 18, // 256 KiB → resume once all sockets are back under
  drainPollMs: 50,
}

/** First session (insertion order) with no attached sockets — the safest to
 *  evict under cap pressure since no browser is watching it. Returns null when
 *  every session is actively viewed (caller rejects the new spawn). Exported
 *  for tests. */
export function pickEvictableTab(sessions) {
  for (const [tabId, entry] of sessions) {
    if (entry.sockets.size === 0) return tabId
  }
  return null
}

/** Pause the pty when ANY open socket has more than `highWaterBytes` queued —
 *  one slow client is enough to grow node memory unbounded. Exported for tests. */
export function shouldPausePty(sockets, highWaterBytes) {
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount > highWaterBytes) {
      return true
    }
  }
  return false
}

/** Resume only when EVERY open socket has drained back under `lowWaterBytes`
 *  (an empty socket set resumes immediately). Exported for tests. */
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
  onEngineSessionStart = () => {},
  onEngineSessionStop = () => {},
}) {
  /** @type {Map<string, { pty: any, scrollback: ReturnType<createScrollback>, sockets: Set<any> }>} */
  const sessions = new Map()
  /** @type {Map<string, Promise<any>>} */
  const pendingSpawns = new Map()

  /** Pause the pty once a socket is saturated and poll for drain to resume.
   *  Idempotent: a second saturation while already paused is a no-op. */
  function applyBackpressure(entry) {
    if (entry.paused) return
    if (!shouldPausePty(entry.sockets, backpressure.highWaterBytes)) return
    entry.paused = true
    try {
      entry.pty.pause?.()
    } catch {
      /* engine died — onExit clears the entry */
    }
    if (entry.drainTimer !== null) return
    entry.drainTimer = setIntervalFn(() => {
      if (!shouldResumePty(entry.sockets, backpressure.lowWaterBytes)) return
      clearDrainTimer(entry)
      entry.paused = false
      try {
        entry.pty.resume?.()
      } catch {
        /* engine died — onExit clears the entry */
      }
    }, backpressure.drainPollMs)
  }

  function clearDrainTimer(entry) {
    if (entry.drainTimer !== null) {
      clearIntervalFn(entry.drainTimer)
      entry.drainTimer = null
    }
  }

  function spawnSession(tabId, spec, cols, rows, identity) {
    // Enforce the session cap before allocating another process: evict the
    // oldest unwatched session, or reject when every session is in active use.
    if (sessions.size >= maxSessions && !sessions.has(tabId)) {
      const victim = pickEvictableTab(sessions)
      if (victim === null) {
        throw new Error(`pty session limit reached (${maxSessions})`)
      }
      closeSession(victim)
    }
    const [cmd, ...args] = spec.command
    const base = typeof env === "function" ? env() : env
    // Spec-supplied identity env (KOBE_TASK_ID/KOBE_TAB_ID for shell tabs).
    const spawnEnv = spec.env ? { ...base, ...spec.env } : base
    let pty
    try {
      pty = spawnPty(cmd, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: spec.cwd,
        env: spawnEnv,
      })
    } catch (error) {
      const path = typeof spawnEnv.PATH === "string" && spawnEnv.PATH ? "set" : "missing"
      throw new Error(`PTY spawn failed (command ${cmd}, cwd ${spec.cwd}, PATH ${path}): ${error instanceof Error ? error.message : String(error)}`)
    }
    const entry = {
      pty,
      ...identity,
      startedAt: Date.now(),
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
      stopEngineWatch(tabId, entry)
      clearDrainTimer(entry)
      for (const ws of entry.sockets) {
        if (ws.readyState === ws.OPEN) ws.close(1000, "engine exited")
      }
      if (sessions.get(tabId) === entry) sessions.delete(tabId)
    })
    sessions.set(tabId, entry)
    if (entry.mode === "engine") {
      onEngineSessionStart({
        taskId: entry.taskId,
        tabId,
        vendor: entry.vendor,
        rootPid: entry.pty.pid,
        startedAt: entry.startedAt,
      })
    }
    return entry
  }

  function stopEngineWatch(tabId, entry) {
    if (entry.mode !== "engine" || entry.watchStopped) return
    entry.watchStopped = true
    onEngineSessionStop({ taskId: entry.taskId, tabId, rootPid: entry.pty.pid })
  }

  async function ensureSession(tabId, taskId, mode, cols, rows, vendor) {
    const existing = sessions.get(tabId)
    if (existing) return existing
    const inflight = pendingSpawns.get(tabId)
    if (inflight) return inflight
    const p = (async () => {
      // Vendor override only applies to engine PTYs — shell mode has no engine-spec.
      const spec = await fetchSpec(taskId, mode, mode === "engine" ? vendor : undefined, tabId)
      return sessions.get(tabId) ?? spawnSession(tabId, spec, cols, rows, { taskId, mode, vendor })
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

  async function attachSocket({ ws, tabId, taskId, mode, cols, rows, vendor }) {
    const entry = await ensureSession(tabId, taskId, mode, cols, rows, vendor)
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
    stopEngineWatch(tabId, entry)
    clearDrainTimer(entry)
    try {
      entry.pty.kill()
    } catch {
      /* already gone */
    }
    if (sessions.get(tabId) === entry) sessions.delete(tabId)
    return true
  }

  /** Paste into an already-hosted PTY without submitting. This is the
   * composer-fill primitive used by Agent Trace quoting. */
  function insertText({ tabId, text }) {
    const entry = sessions.get(tabId)
    if (!entry) return { inserted: false, missing: true }
    try {
      // Trace output is external text. Strip terminal control bytes so it
      // cannot close the bracketed-paste envelope or synthesize keystrokes.
      const safeText = text
        .replace(/\r\n?/g, "\n")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      entry.pty.write(`\x1b[200~${safeText}\x1b[201~`)
      return { inserted: true, missing: false }
    } catch {
      return { inserted: false, missing: false }
    }
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
    for (const [tabId, entry] of sessions) {
      stopEngineWatch(tabId, entry)
      clearDrainTimer(entry)
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
    insertText,
    sendText,
    shutdown,
    sessionCount: () => sessions.size,
    pendingSpawnCount: () => pendingSpawns.size,
    // Live shell pids for the foreground-process walk (/pty/foreground).
    listSessions: () => [...sessions.entries()].map(([tabId, entry]) => ({ tabId, pid: entry.pty.pid })),
  }
}
