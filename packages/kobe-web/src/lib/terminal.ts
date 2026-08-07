/**
 * Terminal client. Each PTY-backed workspace tab is owned by the node
 * pty-server; the xterm attaches by the tab's client-generated id. Vendor
 * tabs spawn the configured engine in the task's worktree. Terminal tabs
 * spawn the user's shell in the same worktree.
 */

import { ApiError, api } from "./api-client.ts"

export type PtyMode = "engine" | "shell"

/** PTY sidecar origin (port + 2). `ws` picks ws/wss; `http` picks http/https. */
export function ptyBase(kind: "ws" | "http"): string {
  const secure = location.protocol === "https:"
  const proto =
    kind === "ws" ? (secure ? "wss" : "ws") : secure ? "https" : "http"
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
  vendor?: string,
): string {
  const q = new URLSearchParams({
    tab: tabId,
    taskId,
    mode,
    cols: String(cols),
    rows: String(rows),
  })
  if (vendor) q.set("vendor", vendor)
  return `${ptyBase("ws")}/pty?${q.toString()}`
}

/** URL for a Claude-cached `[Image #N]` (the sidecar serves it from
 *  ~/.claude/image-cache/<session>/<n>.<ext>). The engine owns `sessionId`
 *  (daemon engine-state); the sidecar just reads the file. */
export function engineImageUrl(sessionId: string, n: number): string {
  const q = new URLSearchParams({ session: sessionId, n: String(n) })
  return `${ptyBase("http")}/image?${q.toString()}`
}

/** Live descendant process names per tab (sidecar ps walk) — the sidebar
 *  matches them against engine ids to trace a shell tab running an engine. */
export async function fetchPtyForeground(): Promise<Record<string, string[]>> {
  try {
    const res = await fetch(`${ptyBase("http")}/pty/foreground`)
    if (!res.ok) return {}
    return (await res.json()) as Record<string, string[]>
  } catch {
    return {}
  }
}

/** Kill a tab's engine process server-side (when the user closes the tab). */
export async function closePtyTab(tabId: string): Promise<void> {
  try {
    await api.post<void>(
      `${ptyBase("http")}/pty/close`,
      { tab: tabId },
      { label: "close PTY tab" },
    )
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
  try {
    const json = await api.post<{ sent?: boolean; spawned?: boolean }>(
      `${ptyBase("http")}/pty/send`,
      { tab: tabId, taskId, text },
      { label: "send PTY text" },
    )
    if (!json.sent) throw new Error("send failed")
    return { spawned: json.spawned === true }
  } catch (err) {
    // A sidecar that predates this endpoint 404s with an empty body; keep the
    // targeted restart hint instead of surfacing a generic status error.
    if (err instanceof ApiError && err.status === 404 && !err.detail) {
      throw new Error(
        "the PTY server doesn't know /pty/send — restart `kobe web` (the sidecar doesn't hot-reload)",
      )
    }
    throw err
  }
}
