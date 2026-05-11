/**
 * Unit tests for `dispatchKeyEvent` — the pure dispatch core of
 * `useBindings`. Regression coverage for KOB-?? where an Enter that
 * fired `sidebar.select` (and pulled focus to the workspace) then
 * leaked into the freshly-focused composer's textarea `onSubmit`,
 * auto-sending the user's saved draft.
 *
 * The fix: on a binding hit, `dispatchKeyEvent` calls
 * `evt.preventDefault()` so native opentui widgets (textarea, etc.)
 * don't also receive the key in the same tick.
 */

import { describe, expect, test } from "bun:test"
import { type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap"

function makeEvt(name: string, mods: Partial<{ ctrl: boolean; meta: boolean; option: boolean; shift: boolean }> = {}) {
  let defaultPrevented = false
  return {
    name,
    ctrl: mods.ctrl ?? false,
    meta: mods.meta ?? false,
    option: mods.option ?? false,
    shift: mods.shift ?? false,
    get defaultPrevented() {
      return defaultPrevented
    },
    preventDefault() {
      defaultPrevented = true
    },
  }
}

function makeReg(id: number, key: string, cmd: () => void, enabled = true): RegisteredBinding {
  return {
    id,
    config: () => ({ enabled, bindings: [{ key, cmd }] }),
  }
}

describe("dispatchKeyEvent", () => {
  test("fires the first matching binding and consumes the event", () => {
    let fired = false
    const stack: RegisteredBinding[] = [makeReg(1, "enter", () => (fired = true))]
    const evt = makeEvt("return") // "return" should alias to "enter"

    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(true)
    expect(fired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("does NOT call preventDefault when no binding matches", () => {
    const stack: RegisteredBinding[] = [makeReg(1, "escape", () => {})]
    const evt = makeEvt("k")

    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(false)
    expect(evt.defaultPrevented).toBe(false)
  })

  test("walks the stack top-down (LIFO) — topmost binding wins", () => {
    const fired: number[] = []
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => fired.push(1)), // bottom
      makeReg(2, "enter", () => fired.push(2)), // top
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(fired).toEqual([2])
    expect(evt.defaultPrevented).toBe(true)
  })

  test("skips disabled registrations and falls through to enabled ones", () => {
    let bottomFired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => (bottomFired = true)),
      makeReg(2, "enter", () => {}, /* enabled */ false),
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(bottomFired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("an already-prevented event short-circuits without firing anything", () => {
    let fired = false
    const stack: RegisteredBinding[] = [makeReg(1, "enter", () => (fired = true))]
    const evt = makeEvt("return")
    evt.preventDefault() // simulate a higher-priority handler having already consumed

    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(false)
    expect(fired).toBe(false)
  })

  test("regression: Enter that triggers sidebar.select must not leak to textarea.onSubmit", () => {
    // Simulates the production race: useBindings has a sidebar.select
    // binding registered, the user presses Enter, the handler fires and
    // pulls focus elsewhere. Native widgets reading `defaultPrevented`
    // should see `true` and stay quiet.
    let sidebarFired = false
    const stack: RegisteredBinding[] = [makeReg(1, "enter", () => (sidebarFired = true))]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(sidebarFired).toBe(true)
    // If a downstream native widget were to check this before firing
    // its own onSubmit, it would correctly bail.
    expect(evt.defaultPrevented).toBe(true)
  })

  test("modifier chords (ctrl+k) match correctly", () => {
    let fired = false
    const stack: RegisteredBinding[] = [makeReg(1, "ctrl+k", () => (fired = true))]
    const evt = makeEvt("k", { ctrl: true })

    dispatchKeyEvent(stack, evt)

    expect(fired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("bare letter does not match modifier-prefixed binding", () => {
    let fired = false
    const stack: RegisteredBinding[] = [makeReg(1, "ctrl+k", () => (fired = true))]
    const evt = makeEvt("k") // no ctrl

    dispatchKeyEvent(stack, evt)

    expect(fired).toBe(false)
    expect(evt.defaultPrevented).toBe(false)
  })
})
