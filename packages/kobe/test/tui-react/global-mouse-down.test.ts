import { describe, expect, it } from "vitest"
import { type MouseDownHost, subscribeGlobalMouseDown } from "../../src/tui-react/lib/global-mouse-down.ts"

function fakeHost(): MouseDownHost {
  return { onMouseDown: undefined }
}

describe("subscribeGlobalMouseDown", () => {
  it("installs one root listener and fans it out to every subscriber", () => {
    const host = fakeHost()
    const seen: string[] = []
    const offA = subscribeGlobalMouseDown(host, () => seen.push("a"))
    const offB = subscribeGlobalMouseDown(host, () => seen.push("b"))

    expect(host.onMouseDown).toBeTypeOf("function")
    host.onMouseDown?.({})
    expect(seen).toEqual(["a", "b"])

    offA()
    // Still one subscriber: the listener stays installed.
    expect(host.onMouseDown).toBeTypeOf("function")
    host.onMouseDown?.({})
    expect(seen).toEqual(["a", "b", "b"])

    offB()
    expect(host.onMouseDown).toBeUndefined()
  })

  it("survives a handler that unsubscribes itself mid-dispatch", () => {
    const host = fakeHost()
    let calls = 0
    const off = subscribeGlobalMouseDown(host, () => {
      calls += 1
      off()
    })
    host.onMouseDown?.({})
    expect(calls).toBe(1)
    expect(host.onMouseDown).toBeUndefined()
  })

  it("re-points at a fresh host (renderer swap) instead of firing into the dead one", () => {
    const first = fakeHost()
    const off1 = subscribeGlobalMouseDown(first, () => {})
    const second = fakeHost()
    const seen: string[] = []
    const off2 = subscribeGlobalMouseDown(second, () => seen.push("live"))

    expect(first.onMouseDown).toBeUndefined()
    expect(second.onMouseDown).toBeTypeOf("function")
    second.onMouseDown?.({})
    expect(seen).toEqual(["live"])
    off1()
    off2()
    expect(second.onMouseDown).toBeUndefined()
  })
})
