import { afterEach, describe, expect, test } from "vitest"
import { bindByIds } from "../../src/tui/context/keybindings"
import {
  type RegisteredBinding,
  armPrefixNow,
  configurePrefix,
  dispatchKeyEvent,
  resetPrefixConfiguration,
  resetPrefixState,
} from "../../src/tui/lib/keymap-dispatch"

function event(name: string, ctrl = false) {
  let defaultPrevented = false
  return {
    name,
    ctrl,
    meta: false,
    option: false,
    shift: false,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault() {
      defaultPrevented = true
    },
  }
}

function registration(id: number, enabled: boolean, key: string, cmd: () => void): RegisteredBinding {
  return { id, config: () => ({ enabled, bindings: [{ key, prefix: true, cmd }] }) }
}

afterEach(() => {
  resetPrefixConfiguration()
  resetPrefixState()
})

describe("PureTUI prefix dispatch", () => {
  test("routes default prefix+h/l to previous/next without reclaiming ctrl+h/j/k/l", () => {
    const calls: string[] = []
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
          bindings: bindByIds({
            "focus.previous": () => calls.push("previous"),
            "focus.next": () => calls.push("next"),
            "inbox.show": () => calls.push("inbox"),
          }),
        }),
      },
    ]

    expect(dispatchKeyEvent(stack, event("a", true), 100)).toBe(true)
    expect(dispatchKeyEvent(stack, event("h"), 101)).toBe(true)
    expect(dispatchKeyEvent(stack, event("a", true), 102)).toBe(true)
    expect(dispatchKeyEvent(stack, event("l"), 103)).toBe(true)
    expect(dispatchKeyEvent(stack, event("a", true), 104)).toBe(true)
    expect(dispatchKeyEvent(stack, event("i"), 105)).toBe(true)
    expect(calls).toEqual(["previous", "next", "inbox"])

    for (const key of ["h", "j", "k", "l"]) {
      expect(dispatchKeyEvent(stack, event(key, true), 104)).toBe(false)
    }
  })

  test("fires the enabled Binding Stack prefix row after ctrl+a", () => {
    let calls = 0
    const stack = [registration(1, true, "t", () => calls++)]

    expect(dispatchKeyEvent(stack, event("a", true), 100)).toBe(true)
    expect(dispatchKeyEvent(stack, event("t"), 101)).toBe(true)
    expect(calls).toBe(1)
  })

  test("does not cross an enabled Workspace Host scope into a disabled Tasks pane row", () => {
    let taskCalls = 0
    let tabCalls = 0
    const stack = [registration(1, false, "n", () => taskCalls++), registration(2, true, "t", () => tabCalls++)]

    dispatchKeyEvent(stack, event("a", true), 100)
    expect(dispatchKeyEvent(stack, event("n"), 101)).toBe(true)
    expect(taskCalls).toBe(0)
    expect(tabCalls).toBe(0)
  })

  test("expires an armed prefix before the second stroke", () => {
    let prefixCalls = 0
    let directCalls = 0
    configurePrefix({ key: "ctrl+a", timeoutMs: 1000 })
    const stack: RegisteredBinding[] = [
      registration(1, true, "t", () => prefixCalls++),
      { id: 2, config: () => ({ bindings: [{ key: "t", cmd: () => directCalls++ }] }) },
    ]

    dispatchKeyEvent(stack, event("a", true), 100)
    expect(dispatchKeyEvent(stack, event("t"), 1101)).toBe(true)
    expect(prefixCalls).toBe(0)
    expect(directCalls).toBe(1)
  })

  test("escape cancels an armed prefix without running its second stroke", () => {
    let calls = 0
    const stack = [registration(1, true, "t", () => calls++)]

    dispatchKeyEvent(stack, event("a", true), 100)
    expect(dispatchKeyEvent(stack, event("escape"), 101)).toBe(true)
    expect(dispatchKeyEvent(stack, event("t"), 102)).toBe(false)
    expect(calls).toBe(0)
  })

  test("does not dispatch an armed prefix below a modal barrier", () => {
    let calls = 0
    const stack = [registration(1, true, "t", () => calls++), { id: 2, config: () => ({ modal: true, bindings: [] }) }]

    expect(dispatchKeyEvent(stack, event("a", true), 100)).toBe(false)
    expect(dispatchKeyEvent(stack, event("t"), 101)).toBe(false)
    expect(calls).toBe(0)
  })
})

describe("armPrefixNow (mouse path into the command layer)", () => {
  test("arms against a reachable stack and the next key dispatches as a second stroke", () => {
    const calls: string[] = []
    const stack: RegisteredBinding[] = [registration(1, true, "f", () => calls.push("fork"))]
    expect(armPrefixNow(stack)).toBe(true)
    expect(dispatchKeyEvent(stack, event("f") as never)).toBe(true)
    expect(calls).toEqual(["fork"])
  })

  test("no-ops when the prefix is disabled", () => {
    configurePrefix({ key: null, timeoutMs: 5000 })
    const stack: RegisteredBinding[] = [registration(1, true, "f", () => {})]
    expect(armPrefixNow(stack)).toBe(false)
  })

  test("arms while terminal passthrough owns unrelated input", () => {
    const calls: string[] = []
    const stack: RegisteredBinding[] = [
      registration(1, true, "f", () => calls.push("fork")),
      { id: 2, config: () => ({ enabled: true, bindings: [{ key: "a", cmd: () => {}, passthrough: true }] }) },
    ]
    expect(armPrefixNow(stack)).toBe(true)
    expect(dispatchKeyEvent(stack, event("f") as never)).toBe(true)
    expect(calls).toEqual(["fork"])
  })

  test("no-ops when a modal barrier hides every prefix row", () => {
    const stack: RegisteredBinding[] = [
      registration(1, true, "f", () => {}),
      { id: 2, config: () => ({ enabled: true, modal: true, bindings: [] }) },
    ]
    expect(armPrefixNow(stack)).toBe(false)
  })
})
