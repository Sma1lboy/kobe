import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { describe, expect, it } from "vitest"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

/**
 * Minimal fake daemon client: RemoteOrchestrator only needs `on("*", …)`
 * (to receive channel events) and `onLifecycle` (for the close hook) at
 * construction time. `emit` replays a daemon event frame through the
 * captured `*` handler, exactly as the real socket layer would.
 */
function fakeClient(): { client: KobeDaemonClient; emit: (name: string, payload: unknown) => void } {
  let star: ((frame: { name: string; payload: unknown }) => void) | undefined
  const client = {
    on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
      if (name === "*") star = handler
      return () => {}
    },
    onLifecycle: () => () => {},
  } as unknown as KobeDaemonClient
  return { client, emit: (name, payload) => star?.({ name, payload }) }
}

describe("RemoteOrchestrator channel handling", () => {
  it("reflects the daemon-owned `update` channel in updateSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.updateSignal()()).toBeNull()

    const info = { current: "1.0.0", latest: "1.1.0", hasUpdate: true }
    emit("update", { info })
    expect(orch.updateSignal()()).toEqual(info)

    // A later null poll (dev/offline) clears the signal; the consuming pane
    // is what keeps the last-known value sticky, not the orchestrator.
    emit("update", { info: null })
    expect(orch.updateSignal()()).toBeNull()
  })

  it("reflects the `active-task` channel in activeTaskSignal", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.activeTaskSignal()()).toBeNull()

    emit("active-task", { taskId: "t1" })
    expect(orch.activeTaskSignal()()).toBe("t1")

    emit("active-task", { taskId: null })
    expect(orch.activeTaskSignal()()).toBeNull()
  })

  it("treats a malformed update payload as null", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("update", undefined)
    expect(orch.updateSignal()()).toBeNull()
  })
})
