import { type RegisteredBinding, dispatchKeyEvent } from "@/tui/lib/keymap-dispatch"
import { describe, expect, test } from "vitest"

type Tab = "existing" | "clone" | "adopt"

function ctrlASlice(tab: Tab, onSelectAll: () => void) {
  return tab === "adopt" ? [{ key: "ctrl+a", cmd: onSelectAll }] : []
}

function evt(name: string, ctrl = false) {
  let prevented = false
  return {
    name,
    ctrl,
    defaultPrevented: false,
    preventDefault() {
      prevented = true
    },
    get prevented() {
      return prevented
    },
  }
}

function stackFor(bindings: ReturnType<typeof ctrlASlice>): RegisteredBinding[] {
  return [{ id: 1, config: () => ({ bindings }) }]
}

describe("new-task dialog ctrl+a registration gate", () => {
  test("Existing/Clone tabs: ctrl+a is UNCLAIMED so it reaches the input as line-home", () => {
    for (const tab of ["existing", "clone"] as const) {
      let calls = 0
      const e = evt("a", true)
      const hit = dispatchKeyEvent(stackFor(ctrlASlice(tab, () => calls++)), e)
      expect(hit).toBe(false)
      expect(e.prevented).toBe(false)
      expect(calls).toBe(0)
    }
  })

  test("Adopt tab: ctrl+a fires select-all and consumes the key", () => {
    let calls = 0
    const e = evt("a", true)
    const hit = dispatchKeyEvent(stackFor(ctrlASlice("adopt", () => calls++)), e)
    expect(hit).toBe(true)
    expect(e.prevented).toBe(true)
    expect(calls).toBe(1)
  })
})
