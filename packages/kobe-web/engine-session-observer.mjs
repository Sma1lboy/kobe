/**
 * Neutral PTY-side trigger for engine-owned session observation.
 *
 * The sidecar knows tab/process identity but not provider log formats. After a
 * terminal commit it asks the daemon to run the selected engine adapter. A
 * bounded retry window covers both the provider persisting its activation and
 * a resumed app-server thread completing startup after Enter reaches the PTY.
 */

const DEFAULT_DELAYS_MS = [0, 100, 300, 750, 1500, 3000]

export function createEngineSessionObservationClient({
  daemonWebPort,
  fetchFn = fetch,
  setTimeoutFn = setTimeout,
  delaysMs = DEFAULT_DELAYS_MS,
}) {
  const generations = new Map()

  function observe({ taskId, tabId, vendor, rootPid }) {
    if (!taskId || !tabId || !Number.isInteger(rootPid) || rootPid <= 0) return
    const generation = (generations.get(tabId) ?? 0) + 1
    generations.set(tabId, generation)
    for (const delayMs of delaysMs) {
      const timer = setTimeoutFn(() => {
        if (generations.get(tabId) !== generation) return
        void fetchFn(`http://127.0.0.1:${daemonWebPort}/api/rpc`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "engine.observeSession",
            payload: { taskId, tabId, rootPid, ...(vendor ? { vendor } : {}) },
          }),
        }).catch(() => {})
      }, delayMs)
      timer?.unref?.()
    }
  }

  return {
    observe,
    forget(tabId) {
      generations.delete(tabId)
    },
  }
}
