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

import { describe, expect, test } from "vitest"
import { type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"

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
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => {
        fired = true
      }),
    ]
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
      makeReg(1, "enter", () => {
        bottomFired = true
      }),
      makeReg(2, "enter", () => {}, /* enabled */ false),
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(bottomFired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("a disabled matching group lets the key fall through (the settings `{file}` l-eaten fix)", () => {
    // Repro of the bug: the standalone Settings page kept `l`=enterBody
    // active under an open text input, swallowing the `l` in `{file}`.
    // The fix disables that nav group while a sub-dialog is open; with it
    // disabled and no other group binding `l`, dispatch must return false
    // so the native <input> receives the keystroke.
    let navFired = false
    const stack: RegisteredBinding[] = [
      makeReg(
        1,
        "l",
        () => {
          navFired = true
        },
        /* enabled */ false,
      ), // settings nav, suspended while the input dialog is open
      makeReg(2, "escape", () => {}), // the input dialog only binds escape
    ]
    const evt = makeEvt("l")

    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(false)
    expect(navFired).toBe(false)
    expect(evt.defaultPrevented).toBe(false)
  })

  test("an already-prevented event short-circuits without firing anything", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => {
        fired = true
      }),
    ]
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
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => {
        sidebarFired = true
      }),
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(sidebarFired).toBe(true)
    // If a downstream native widget were to check this before firing
    // its own onSubmit, it would correctly bail.
    expect(evt.defaultPrevented).toBe(true)
  })

  test("modifier chords (ctrl+k) match correctly", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+k", () => {
        fired = true
      }),
    ]
    const evt = makeEvt("k", { ctrl: true })

    dispatchKeyEvent(stack, evt)

    expect(fired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("bare letter does not match modifier-prefixed binding", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+k", () => {
        fired = true
      }),
    ]
    const evt = makeEvt("k") // no ctrl

    dispatchKeyEvent(stack, evt)

    expect(fired).toBe(false)
    expect(evt.defaultPrevented).toBe(false)
  })

  // ─── Slot threading (direction-multiplexed bindings) ─────────────────
  // `bindByIds` registers one Binding per chord with `slot` = the chord's
  // index in the id's keys array; the dispatcher must hand that slot to
  // the handler so it can map slot → direction without reading evt.name.

  test("passes the matched binding's slot to the handler", () => {
    const seen: Array<number | undefined> = []
    const cmd = (_evt: unknown, slot?: number) => {
      seen.push(slot)
    }
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
          // bindByIds shape for sidebar.nav defaults [j, k, down, up].
          bindings: [
            { key: "j", cmd, slot: 0 },
            { key: "k", cmd, slot: 1 },
            { key: "down", cmd, slot: 2 },
            { key: "up", cmd, slot: 3 },
          ],
        }),
      },
    ]

    for (const name of ["j", "k", "down", "up"]) {
      dispatchKeyEvent(stack, makeEvt(name))
    }

    expect(seen).toEqual([0, 1, 2, 3])
  })

  test("a binding registered without a slot delivers undefined (hand-rolled literals)", () => {
    let seen: number | undefined = 99
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
          bindings: [
            {
              key: "escape",
              cmd: (_evt, slot) => {
                seen = slot
              },
            },
          ],
        }),
      },
    ]

    dispatchKeyEvent(stack, makeEvt("escape"))

    expect(seen).toBeUndefined()
  })

  test("duplicate chords across slots: the first registered slot wins", () => {
    const seen: number[] = []
    const cmd = (_evt: unknown, slot?: number) => {
      seen.push(slot ?? -1)
    }
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
          bindings: [
            { key: "w", cmd, slot: 0 },
            { key: "w", cmd, slot: 1 }, // user wrote the same chord twice
          ],
        }),
      },
    ]

    dispatchKeyEvent(stack, makeEvt("w"))

    expect(seen).toEqual([0])
  })
})
