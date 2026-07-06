import { ApiError, api } from "./api-client.ts"

export type PtyMode = "engine" | "shell"

function ptyBase(kind: "ws" | "http"): string {
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
): string {
  const q = new URLSearchParams({
    tab: tabId,
    taskId,
    mode,
    cols: String(cols),
    rows: String(rows),
  })
  return `${ptyBase("ws")}/pty?${q.toString()}`
}

export async function closePtyTab(tabId: string): Promise<void> {
  try {
    await api.post<void>(
      `${ptyBase("http")}/pty/close`,
      { tab: tabId },
      { label: "close PTY tab" },
    )
  } catch {}
}

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
    if (err instanceof ApiError && err.status === 404 && !err.detail) {
      throw new Error(
        "the PTY server doesn't know /pty/send — restart `kobe web` (the sidecar doesn't hot-reload)",
      )
    }
    throw err
  }
}
