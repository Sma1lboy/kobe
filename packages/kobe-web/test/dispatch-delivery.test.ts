import { beforeEach, describe, expect, it } from "vitest"
import { deliverToSession, shouldDeliver } from "../src/lib/dispatch-delivery.ts"
import type { SessionDeliver } from "../src/lib/types.ts"

/**
 * session.deliver forwarding (docs/design/dispatcher.md). Load-bearing: `at`
 * is the dedupe identity (SSE replays the last event on every reconnect), a
 * failed send rolls the mark back so the replay retries, and delivery goes
 * through the injected tab/send deps (the review-button path).
 */

const event = (over: Partial<SessionDeliver> = {}): SessionDeliver => ({
  taskId: "t1",
  text: "[KOBE CONFLICT RADAR] hello",
  at: 100,
  source: "radar",
  ...over,
})

// Node test env has no localStorage — give the module the real Web Storage
// shape backed by a Map so marks behave like the browser.
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size
    },
  } as Storage
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = fakeStorage()
})

describe("shouldDeliver", () => {
  it("delivers strictly newer events only", () => {
    expect(shouldDeliver(event({ at: 100 }), 0)).toBe(true)
    expect(shouldDeliver(event({ at: 100 }), 100)).toBe(false)
    expect(shouldDeliver(event({ at: 99 }), 100)).toBe(false)
  })
})

describe("deliverToSession", () => {
  function spies() {
    const calls: Array<{ tabId: string; taskId: string; text: string }> = []
    return {
      calls,
      deps: {
        ensureTab: (taskId: string) => `tab-${taskId}`,
        send: async (tabId: string, taskId: string, text: string) => {
          calls.push({ tabId, taskId, text })
          return { spawned: false }
        },
      },
    }
  }

  it("delivers through the injected tab + send path", async () => {
    const { calls, deps } = spies()
    expect(await deliverToSession(event(), deps)).toBe(true)
    expect(calls).toEqual([{ tabId: "tab-t1", taskId: "t1", text: "[KOBE CONFLICT RADAR] hello" }])
  })

  it("the same `at` never delivers twice (reconnect replay is a no-op)", async () => {
    const { calls, deps } = spies()
    await deliverToSession(event(), deps)
    expect(await deliverToSession(event(), deps)).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it("a newer event for the same task delivers again", async () => {
    const { calls, deps } = spies()
    await deliverToSession(event({ at: 100 }), deps)
    await deliverToSession(event({ at: 200, text: "next" }), deps)
    expect(calls).toHaveLength(2)
  })

  it("a failed send rolls the mark back so a replay retries", async () => {
    const failing = {
      ensureTab: () => "tab",
      send: async () => {
        throw new Error("pty down")
      },
    }
    expect(await deliverToSession(event(), failing)).toBe(false)
    const { calls, deps } = spies()
    expect(await deliverToSession(event(), deps)).toBe(true)
    expect(calls).toHaveLength(1)
  })
})
