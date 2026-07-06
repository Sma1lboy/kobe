
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { createDaemonWebRequestHandler, type DaemonWebLink } from "@sma1lboy/kobe-daemon/daemon/web-server"
import { vi } from "vitest"

export interface FakeOpts {
  snapshot?: unknown
  onRequest?: (name: string, payload: unknown) => unknown
}

export function fakeLink(opts: FakeOpts = {}): DaemonWebLink & { calls: Array<{ name: string; payload: unknown }> } {
  const calls: Array<{ name: string; payload: unknown }> = []
  return {
    calls,
    async request<T>(name: DaemonRequestName, payload?: unknown): Promise<T> {
      calls.push({ name, payload })
      return (opts.onRequest?.(name, payload) ?? {}) as T
    },
    snapshot() {
      return opts.snapshot ?? { tasks: [], connected: true }
    },
  }
}

export function build(opts: FakeOpts = {}) {
  const link = fakeLink(opts)
  const tearDown = vi.fn()
  const sseSends = new Set<(type: string, data: unknown) => void>()
  const handle = createDaemonWebRequestHandler({ link, sseSends, tearDownSession: tearDown })
  return { handle, link, tearDown, sseSends }
}

export function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
