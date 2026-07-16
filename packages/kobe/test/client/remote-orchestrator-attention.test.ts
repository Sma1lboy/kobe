import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { describe, expect, it, vi } from "vitest"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

const { logClientError } = vi.hoisted(() => ({ logClientError: vi.fn() }))
vi.mock("@sma1lboy/kobe-daemon/client/client-log", async (importActual) => ({
  ...(await importActual<typeof import("@sma1lboy/kobe-daemon/client/client-log")>()),
  logClientError,
}))

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

describe("RemoteOrchestrator attention channel", () => {
  it("replaces the durable Inbox from full snapshots and rejects malformed payloads", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    const item = { taskId: "t1", tabId: "tab-2", state: "permission_needed" as const, unread: true, at: 42 }

    emit("attention.inbox", { items: [item] })
    expect(orch.attentionInboxSignal()()).toEqual([item])

    emit("attention.inbox", { items: "bad" })
    expect(orch.attentionInboxSignal()()).toEqual([item])
    expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("dropped attention.inbox"))

    emit("attention.inbox", { items: [{ ...item, unread: "yes" }] })
    expect(orch.attentionInboxSignal()()).toEqual([item])

    const legacy = { taskId: "t2", tabId: null, state: "turn_complete" as const, at: 43 }
    emit("attention.inbox", { items: [legacy] })
    expect(orch.attentionInboxSignal()()).toEqual([{ ...legacy, unread: true }])

    emit("attention.inbox", { items: [] })
    expect(orch.attentionInboxSignal()()).toEqual([])
  })
})
