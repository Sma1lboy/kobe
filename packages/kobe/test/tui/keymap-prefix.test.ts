import { afterEach, describe, expect, test } from "vitest"
import {
  type RegisteredBinding,
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
