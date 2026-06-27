/**
 * Client side of the `transcript.activity` channel (perf — deduplicate
 * per-Ops-pane polling). Mirrors the `worktree.changes` coverage:
 *
 *   - The pure parse/equality helpers (`parseTranscriptActivityPayload`,
 *     `sameTranscriptActivityMap`) accept a well-formed map, reject malformed
 *     entries to `null` (never clobber a good map), and gate re-renders.
 *   - The `RemoteOrchestrator` reflects pushes wholesale (absent keys drop),
 *     keeps the same map ref on an unchanged replay, and logs+drops garbage.
 *   - Capability gating in `init()`: a capable daemon seeds an EMPTY map
 *     (trust pushes → the Ops pane stops local polling), an old daemon leaves
 *     the signal null (the pane's local mtime/completion probes engage).
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { describe, expect, it, vi } from "vitest"
import {
  RemoteOrchestrator,
  parseTranscriptActivityPayload,
  sameTranscriptActivityMap,
} from "../../src/client/remote-orchestrator.ts"

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

function fakeRpcClient(hello: Record<string, unknown>) {
  let star: ((frame: { name: string; payload: unknown }) => void) | undefined
  const client = {
    on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
      if (name === "*") star = handler
      return () => {}
    },
    onLifecycle: () => () => {},
    request: async (name: string) => (name === "hello" ? hello : {}),
    subscribe: async () => ({}),
  } as unknown as KobeDaemonClient
  return { client, emit: (name: string, payload: unknown) => star?.({ name, payload }) }
}

const e = (mtimeMs: number, completionId: string | null = null, completionAt = 0) => ({
  mtimeMs,
  completionId,
  completionAt,
})

describe("transcript.activity pure helpers", () => {
  it("parseTranscriptActivityPayload accepts an empty map and rejects malformed entries", () => {
    expect(parseTranscriptActivityPayload({ activity: {} })?.size).toBe(0)
    expect(parseTranscriptActivityPayload(undefined)).toBeNull()
    expect(parseTranscriptActivityPayload({ activity: [] })).toBeNull()
    // missing/non-number mtimeMs
    expect(parseTranscriptActivityPayload({ activity: { "/wt": { completionId: null, completionAt: 0 } } })).toBeNull()
    // completionId neither string nor null
    expect(
      parseTranscriptActivityPayload({ activity: { "/wt": { mtimeMs: 1, completionId: 7, completionAt: 0 } } }),
    ).toBeNull()
  })

  it("parseTranscriptActivityPayload accepts a null completionId", () => {
    const map = parseTranscriptActivityPayload({ activity: { "/wt": e(5, null, 0) } })
    expect(map?.get("/wt")).toEqual({ mtimeMs: 5, completionId: null, completionAt: 0 })
  })

  it("sameTranscriptActivityMap compares entry-wise", () => {
    const a = new Map([["/wt", e(5, "c1", 9)]])
    expect(sameTranscriptActivityMap(a, new Map([["/wt", e(5, "c1", 9)]]))).toBe(true)
    expect(sameTranscriptActivityMap(a, new Map([["/wt", e(6, "c1", 9)]]))).toBe(false)
    expect(sameTranscriptActivityMap(a, new Map([["/wt", e(5, "c2", 9)]]))).toBe(false)
    expect(sameTranscriptActivityMap(a, new Map())).toBe(false)
  })
})

describe("RemoteOrchestrator transcript.activity channel", () => {
  it("starts null (no daemon-collected data → local-probe fallback)", () => {
    const { client } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    expect(orch.transcriptActivitySignal()()).toBeNull()
  })

  it("reflects a pushed map and replaces it wholesale (absent keys drop)", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("transcript.activity", { activity: { "/wt/a": e(2, "c", 1), "/wt/b": e(0) } })
    const first = orch.transcriptActivitySignal()()
    expect(first?.get("/wt/a")).toEqual({ mtimeMs: 2, completionId: "c", completionAt: 1 })
    expect(first?.size).toBe(2)

    emit("transcript.activity", { activity: { "/wt/a": e(2, "c", 1) } })
    const second = orch.transcriptActivitySignal()()
    expect(second?.size).toBe(1)
    expect(second?.has("/wt/b")).toBe(false)
  })

  it("an unchanged push keeps the same map reference (no re-render churn)", () => {
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("transcript.activity", { activity: { "/wt/a": e(1, "c", 1) } })
    const before = orch.transcriptActivitySignal()()
    emit("transcript.activity", { activity: { "/wt/a": e(1, "c", 1) } })
    expect(orch.transcriptActivitySignal()()).toBe(before)
  })

  it("logs (and drops) a malformed payload without clobbering a good map", () => {
    logClientError.mockClear()
    const { client, emit } = fakeClient()
    const orch = new RemoteOrchestrator(client)
    emit("transcript.activity", { activity: { "/wt/a": e(1, "c", 1) } })
    logClientError.mockClear()
    const before = orch.transcriptActivitySignal()()
    emit("transcript.activity", { activity: "nope" })
    expect(orch.transcriptActivitySignal()()).toBe(before)
    expect(logClientError).toHaveBeenCalledTimes(1)
    expect(logClientError).toHaveBeenCalledWith("orch", expect.stringContaining("transcript.activity"))
  })
})

describe("transcript.activity capability gating (init)", () => {
  it("a capable daemon yields an empty map (trust pushes) before any publish", async () => {
    const { client } = fakeRpcClient({ protocolVersion: 3, capabilities: ["task.snapshot", "transcript.activity"] })
    const orch = new RemoteOrchestrator(client)
    await orch.init()
    expect(orch.transcriptActivitySignal()()?.size).toBe(0)
  })

  it("a capability-less (old) daemon resets the signal to null — local fallback engages", async () => {
    const { client, emit } = fakeRpcClient({ protocolVersion: 3, capabilities: ["task.snapshot"] })
    const orch = new RemoteOrchestrator(client)
    emit("transcript.activity", { activity: { "/wt/a": e(1, "c", 1) } })
    await orch.init()
    expect(orch.transcriptActivitySignal()()).toBeNull()
  })

  it("a replayed map delivered during subscribe is not clobbered by init", async () => {
    const { client, emit } = fakeRpcClient({ protocolVersion: 3, capabilities: ["transcript.activity"] })
    const orch = new RemoteOrchestrator(client)
    emit("transcript.activity", { activity: { "/wt/a": e(4, "c4", 2) } })
    await orch.init()
    expect(orch.transcriptActivitySignal()()?.get("/wt/a")).toEqual({ mtimeMs: 4, completionId: "c4", completionAt: 2 })
  })
})
