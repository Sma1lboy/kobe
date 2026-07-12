/**
 * Prefix HUD feed contract (src/tui/lib/prefix-hud.ts): the dispatch layer
 * must arm/disarm the HUD in lockstep with the real prefix state machine and
 * land one entry per resolved sequence — this is what the bottom-left
 * workspace overlay renders, so a drift here means the HUD lies about what
 * a keystroke did.
 */

import { afterEach, describe, expect, test } from "vitest"
import {
  type RegisteredBinding,
  configurePrefix,
  dispatchKeyEvent,
  resetPrefixConfiguration,
  resetPrefixState,
} from "../../src/tui/lib/keymap-dispatch"
import { prefixHudState, resetPrefixHud } from "../../src/tui/lib/prefix-hud"

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

function registration(id: number, key: string, bindingId?: string): RegisteredBinding {
  return { id, config: () => ({ enabled: true, bindings: [{ key, prefix: true, cmd: () => {}, id: bindingId }] }) }
}

afterEach(() => {
  resetPrefixConfiguration()
  resetPrefixState()
  resetPrefixHud()
})

describe("prefix HUD feed", () => {
  test("arming the prefix raises the armed flag; resolving lands an entry and disarms", () => {
    const stack = [registration(1, "t", "tab.new")]

    dispatchKeyEvent(stack, event("a", true), 100)
    expect(prefixHudState().armed).toBe(true)

    dispatchKeyEvent(stack, event("t"), 200)
    const snap = prefixHudState()
    expect(snap.armed).toBe(false)
    expect(snap.entries).toHaveLength(1)
    expect(snap.entries[0]).toMatchObject({ prefixKey: "ctrl+a", stroke: "t", action: "tab.new", at: 200 })
  })

  test("a second stroke that matches nothing lands a null-action (miss) entry", () => {
    const stack = [registration(1, "t", "tab.new")]

    dispatchKeyEvent(stack, event("a", true), 100)
    dispatchKeyEvent(stack, event("x"), 200)

    expect(prefixHudState().entries[0]).toMatchObject({ stroke: "x", action: null })
  })

  test("escape cancels the armed sequence without landing an entry", () => {
    const stack = [registration(1, "t", "tab.new")]

    dispatchKeyEvent(stack, event("a", true), 100)
    dispatchKeyEvent(stack, event("escape"), 200)

    const snap = prefixHudState()
    expect(snap.armed).toBe(false)
    expect(snap.entries).toHaveLength(0)
  })

  test("an expired sequence disarms without landing an entry", () => {
    configurePrefix({ key: "ctrl+a", timeoutMs: 1000 })
    const stack = [registration(1, "t", "tab.new")]

    dispatchKeyEvent(stack, event("a", true), 100)
    dispatchKeyEvent(stack, event("t"), 5000)

    const snap = prefixHudState()
    expect(snap.armed).toBe(false)
    expect(snap.entries).toHaveLength(0)
  })

  test("the feed keeps only the latest three entries", () => {
    const stack = [registration(1, "t", "tab.new")]

    for (const [i, key] of ["t", "x", "y", "z"].entries()) {
      dispatchKeyEvent(stack, event("a", true), 1000 * i)
      dispatchKeyEvent(stack, event(key), 1000 * i + 1)
    }

    const strokes = prefixHudState().entries.map((entry) => entry.stroke)
    expect(strokes).toEqual(["x", "y", "z"])
  })

  test("a direct modifier chord lands an entry with an empty prefixKey", () => {
    const stack: RegisteredBinding[] = [
      { id: 1, config: () => ({ enabled: true, bindings: [{ key: "ctrl+t", cmd: () => {}, id: "tab.new" }] }) },
    ]

    dispatchKeyEvent(stack, event("t", true), 100)

    expect(prefixHudState().entries[0]).toMatchObject({ prefixKey: "", stroke: "ctrl+t", action: "tab.new" })
  })

  test("a plain pane letter does not land an entry", () => {
    const stack: RegisteredBinding[] = [
      { id: 1, config: () => ({ enabled: true, bindings: [{ key: "j", cmd: () => {}, id: "sidebar.nav" }] }) },
    ]

    dispatchKeyEvent(stack, event("j"), 100)

    expect(prefixHudState().entries).toHaveLength(0)
  })

  test("a prefix binding without an id falls back to its chord as the action", () => {
    const stack = [registration(1, "t")]

    dispatchKeyEvent(stack, event("a", true), 100)
    dispatchKeyEvent(stack, event("t"), 200)

    expect(prefixHudState().entries[0]?.action).toBe("t")
  })
})
