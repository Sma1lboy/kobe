import { runTmuxCapturing } from "@/tmux/client"

export const ATTACH_TTL_MS = 3000

type Probe = () => Promise<{ code: number; stdout: string }>

export function createAttachGate(probe: Probe, now: () => number = Date.now): () => Promise<boolean> {
  let refreshedAt = Number.NEGATIVE_INFINITY
  let attached = true
  return async (): Promise<boolean> => {
    if (now() - refreshedAt < ATTACH_TTL_MS) return attached
    refreshedAt = now()
    try {
      const r = await probe()
      const n = Number.parseInt(r.stdout.trim(), 10)
      attached = r.code !== 0 || Number.isNaN(n) ? true : n > 0
    } catch {
      attached = true
    }
    return attached
  }
}

export const sessionAttached = createAttachGate(() =>
  runTmuxCapturing(["display-message", "-p", "#{session_attached}"]),
)
