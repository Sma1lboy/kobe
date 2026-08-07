/** Registers engine PTY process identity; daemon owns provider observation. */

const DEFAULT_HEARTBEAT_MS = 5_000

export function createEngineSessionObservationClient({
  daemonWebPort,
  fetchFn = fetch,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
}) {
  const watches = new Map()

  async function rpc(name, payload) {
    try {
      await fetchFn(`http://127.0.0.1:${daemonWebPort}/api/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, payload }),
      })
    } catch {
      // Heartbeats reconstruct daemon state after a restart.
    }
  }

  function watch(input) {
    if (!input.taskId || !input.tabId || !Number.isInteger(input.rootPid) || input.rootPid <= 0) return
    unwatch(input.tabId)
    const payload = { ...input, startedAt: Number.isFinite(input.startedAt) ? input.startedAt : Date.now() }
    void rpc("engine.watchSession", payload)
    const timer = setIntervalFn(() => void rpc("engine.watchSession", payload), heartbeatMs)
    timer?.unref?.()
    watches.set(input.tabId, { payload, timer })
  }

  function unwatch(tabId, rootPid) {
    const current = watches.get(tabId)
    if (!current || (rootPid !== undefined && current.payload.rootPid !== rootPid)) return
    clearIntervalFn(current.timer)
    watches.delete(tabId)
    void rpc("engine.unwatchSession", {
      taskId: current.payload.taskId,
      tabId: current.payload.tabId,
      rootPid: current.payload.rootPid,
    })
  }

  function close() {
    for (const tabId of [...watches.keys()]) unwatch(tabId)
  }

  return { watch, unwatch, close, watchedCount: () => watches.size }
}
