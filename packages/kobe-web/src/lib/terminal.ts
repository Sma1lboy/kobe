/**
 * Terminal client. Each PTY-backed workspace tab is owned by the node
 * pty-server; the xterm attaches by the tab's client-generated id. Vendor
 * tabs spawn the configured engine in the task's worktree. Terminal tabs
 * spawn the user's shell in the same worktree.
 */

export type PtyMode = "engine" | "shell"

export function ptyUrl(tabId: string, taskId: string, mode: PtyMode, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss" : "ws"
  const q = new URLSearchParams({
    tab: tabId,
    taskId,
    mode,
    cols: String(cols),
    rows: String(rows),
  })
  return `${proto}://${location.host}/pty?${q.toString()}`
}

/** Kill a tab's engine process server-side (when the user closes the tab). */
export async function closePtyTab(tabId: string): Promise<void> {
  try {
    await fetch("/pty/close", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tab: tabId }),
    })
  } catch {
    /* best-effort — the tab is already gone from the UI */
  }
}
