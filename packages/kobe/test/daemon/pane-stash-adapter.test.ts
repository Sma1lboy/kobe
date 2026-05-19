/**
 * Unit tests for `PaneStashAdapter`. Uses a recording fake
 * `ControlClientLike` so each test can assert exactly which tmux
 * commands the adapter issued and in what order, without spawning a
 * real tmux server. The behavior test (`tmux-pane-swap.test.ts`)
 * covers the live wire end of things.
 */

import { describe, expect, it, vi } from "vitest"
import {
  type ControlClientLike,
  PaneStashAdapter,
  PaneStashSpawnFailedError,
} from "../../src/daemon/pane-stash-adapter.ts"
import { createPaneStash } from "../../src/tmux/pane-stash.ts"

interface Call {
  readonly method: string
  readonly args: unknown
}

function makeRecorder(responses: Partial<Record<keyof ControlClientLike, (call: Call) => string[]>> = {}): {
  client: ControlClientLike
  calls: Call[]
} {
  const calls: Call[] = []
  function record<M extends keyof ControlClientLike>(method: M) {
    return async (args: Parameters<ControlClientLike[M]>[0]) => {
      const call = { method, args }
      calls.push(call)
      return responses[method]?.(call) ?? []
    }
  }
  const client: ControlClientLike = {
    splitWindow: record("splitWindow"),
    swapPane: record("swapPane"),
    breakPane: record("breakPane"),
    joinPane: record("joinPane"),
    killPane: record("killPane"),
    selectLayout: record("selectLayout"),
  }
  return { client, calls }
}

function attached() {
  const stash = createPaneStash()
  stash.attach({ stashWindow: "stash", chatSlotPaneId: "%10", savedLayout: "abc,80x24,0,0,1" })
  return stash
}

describe("PaneStashAdapter — ensureSpawnedForTab", () => {
  it("issues split-window with -P -F #{pane_id} into the stash window and registers the new pane", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%99"] })
    const adapter = new PaneStashAdapter({ stash, client })
    const id = await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    expect(id).toBe("%99")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("splitWindow")
    expect(calls[0]?.args).toEqual({
      target: "stash",
      command: "exec claude",
      printFormat: "#{pane_id}",
      detached: true,
    })
    expect(stash.getPaneId("task-A", "tab-1")).toBe("%99")
  })

  it("is idempotent — second call returns the cached id and doesn't issue tmux ops", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%99"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    const id = await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    expect(id).toBe("%99")
    expect(calls).toHaveLength(1)
  })

  it("throws PaneStashSpawnFailedError when tmux doesn't return a pane id", async () => {
    const stash = attached()
    const { client } = makeRecorder({ splitWindow: () => ["banner without pane id"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await expect(adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")).rejects.toThrow(
      PaneStashSpawnFailedError,
    )
    expect(stash.getPaneId("task-A", "tab-1")).toBeNull()
  })

  it("skips banner lines and extracts the first %N match", async () => {
    const stash = attached()
    const { client } = makeRecorder({ splitWindow: () => ["", "noise", "%123"] })
    const adapter = new PaneStashAdapter({ stash, client })
    const id = await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    expect(id).toBe("%123")
  })
})

describe("PaneStashAdapter — swapToChat", () => {
  it("first swap (initial chat slot) → swapPane + selectLayout", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%42"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    await adapter.swapToChat("task-A", "tab-1")
    const methods = calls.map((c) => c.method)
    expect(methods).toEqual(["splitWindow", "swapPane", "selectLayout"])
    // First swap: source = new pane %42, target = original chat slot %10.
    expect(calls[1]?.args).toEqual({ source: "%42", target: "%10", detached: true })
    // Re-apply saved layout targeting the new chat-slot pane id.
    expect(calls[2]?.args).toEqual({ target: "%42", layout: "abc,80x24,0,0,1" })
  })

  it("second swap (something else displayed) → swapPane targeting the previously-displayed pane", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({
      splitWindow: () => {
        const seen = calls.filter((c) => c.method === "splitWindow").length
        return seen === 1 ? ["%42"] : ["%43"]
      },
    })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    await adapter.ensureSpawnedForTab("task-A", "tab-2", "exec claude")
    await adapter.swapToChat("task-A", "tab-1") // displays %42; chat slot id now %42
    calls.length = 0
    await adapter.swapToChat("task-A", "tab-2") // swap %43 with chat slot (= %42)
    const methods = calls.map((c) => c.method)
    expect(methods).toEqual(["swapPane", "selectLayout"])
    expect(calls[0]?.args).toEqual({ source: "%43", target: "%42", detached: true })
    expect(calls[1]?.args).toEqual({ target: "%43", layout: "abc,80x24,0,0,1" })
  })

  it("idempotent swap to the already-displayed pane → no tmux ops", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%42"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    await adapter.swapToChat("task-A", "tab-1")
    calls.length = 0
    await adapter.swapToChat("task-A", "tab-1")
    expect(calls).toEqual([])
  })
})

describe("PaneStashAdapter — killForTab", () => {
  it("issues kill-pane for a stashed (not-displayed) pane and drops the map entry", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%42"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    calls.length = 0
    await adapter.killForTab("task-A", "tab-1")
    expect(calls).toEqual([{ method: "killPane", args: { target: "%42" } }])
    expect(stash.getPaneId("task-A", "tab-1")).toBeNull()
  })

  it("unknown (taskId, tabId) → no tmux ops", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder()
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.killForTab("nope", "nope")
    expect(calls).toEqual([])
  })

  it("displayed pane → throws (caller must swap first); no kill-pane issued", async () => {
    const stash = attached()
    const { client, calls } = makeRecorder({ splitWindow: () => ["%42"] })
    const adapter = new PaneStashAdapter({ stash, client })
    await adapter.ensureSpawnedForTab("task-A", "tab-1", "exec claude")
    await adapter.swapToChat("task-A", "tab-1")
    calls.length = 0
    await expect(adapter.killForTab("task-A", "tab-1")).rejects.toThrow(/currently displayed/)
    const killCalls = calls.filter((c) => c.method === "killPane")
    expect(killCalls).toEqual([])
  })
})

describe("PaneStashAdapter — guard against unattached stash", () => {
  it("ensureSpawnedForTab throws if the stash has not been attached", async () => {
    const stash = createPaneStash() // never attached
    const { client } = makeRecorder()
    const adapter = new PaneStashAdapter({ stash, client })
    const spy = vi.fn()
    await adapter.ensureSpawnedForTab("t", "tab", "cmd").catch(spy)
    expect(spy).toHaveBeenCalledOnce()
  })
})
