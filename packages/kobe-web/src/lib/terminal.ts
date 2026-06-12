/**
 * Terminal client. Each PTY-backed workspace tab is owned by the node
 * pty-server; the xterm attaches by the tab's client-generated id. Vendor
 * tabs spawn the configured engine in the task's worktree. Terminal tabs
 * spawn the user's shell in the same worktree.
 */

export type PtyMode = "engine" | "shell"

function ptyOrigin(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const host = location.hostname || "localhost"
  const currentPort = Number.parseInt(location.port || "5173", 10)
  const ptyPort = Number.isFinite(currentPort) ? currentPort + 2 : 5175
  return `${proto}://${host}:${ptyPort}`
}

function ptyHttpOrigin(): string {
  const proto = location.protocol === "https:" ? "https" : "http"
  const host = location.hostname || "localhost"
  const currentPort = Number.parseInt(location.port || "5173", 10)
  const ptyPort = Number.isFinite(currentPort) ? currentPort + 2 : 5175
  return `${proto}://${host}:${ptyPort}`
}

export function ptyUrl(
  tabId: string,
  taskId: string,
  mode: PtyMode,
  cols: number,
  rows: number,
): string {
  const q = new URLSearchParams({
    tab: tabId,
    taskId,
    mode,
    cols: String(cols),
    rows: String(rows),
  })
  return `${ptyOrigin()}/pty?${q.toString()}`
}

/** Kill a tab's engine process server-side (when the user closes the tab). */
export async function closePtyTab(tabId: string): Promise<void> {
  try {
    await fetch(`${ptyHttpOrigin()}/pty/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: tabId }),
    })
  } catch {
    /* best-effort — the tab is already gone from the UI */
  }
}

/**
 * Paste text + Enter into a tab's engine — the composer's submit contract,
 * fired from outside any terminal view (board quick actions). The sidecar
 * spawns the engine on demand when the tab has no process yet, so a board
 * action works without the terminal ever having been opened; output lands
 * in the scrollback ring for the next attach. Throws on failure so callers
 * can toast.
 */
export async function sendPtyText(
  tabId: string,
  taskId: string,
  text: string,
): Promise<{ spawned: boolean }> {
  const res = await fetch(`${ptyHttpOrigin()}/pty/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: tabId, taskId, text }),
  })
  const json = (await res.json()) as {
    sent?: boolean
    spawned?: boolean
    error?: string
  }
  if (!res.ok || !json.sent) {
    throw new Error(json.error ?? `send failed (${res.status})`)
  }
  return { spawned: json.spawned === true }
}
