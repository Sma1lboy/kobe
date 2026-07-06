import { describe, expect, test } from "vitest"
import { type RegisteredBinding, dispatchKeyEvent } from "../../src/tui/lib/keymap-dispatch"

function makeEvt(
  name: string,
  mods: Partial<{ ctrl: boolean; meta: boolean; option: boolean; shift: boolean; raw: string }> = {},
) {
  let defaultPrevented = false
  return {
    name,
    raw: mods.raw,
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
    const evt = makeEvt("return")

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
      makeReg(1, "enter", () => fired.push(1)),
      makeReg(2, "enter", () => fired.push(2)),
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
      makeReg(2, "enter", () => {}, false),
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(bottomFired).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("a disabled matching group lets the key fall through (the settings `{file}` l-eaten fix)", () => {
    let navFired = false
    const stack: RegisteredBinding[] = [
      makeReg(
        1,
        "l",
        () => {
          navFired = true
        },
        false,
      ),
      makeReg(2, "escape", () => {}),
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
    evt.preventDefault()

    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(false)
    expect(fired).toBe(false)
  })

  test("regression: Enter that triggers sidebar.select must not leak to textarea.onSubmit", () => {
    let sidebarFired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => {
        sidebarFired = true
      }),
    ]
    const evt = makeEvt("return")

    dispatchKeyEvent(stack, evt)

    expect(sidebarFired).toBe(true)
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
    const evt = makeEvt("k")

    dispatchKeyEvent(stack, evt)

    expect(fired).toBe(false)
    expect(evt.defaultPrevented).toBe(false)
  })

  test("passes the matched binding's slot to the handler", () => {
    const seen: Array<number | undefined> = []
    const cmd = (_evt: unknown, slot?: number) => {
      seen.push(slot)
    }
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
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

  test("a handler that mutates the stack during cmd() does not break dispatch", () => {
    let topFires = 0
    let bottomFires = 0
    const stack: RegisteredBinding[] = []
    const bottom = makeReg(1, "enter", () => {
      bottomFires++
    })
    const top = makeReg(2, "enter", () => {
      topFires++
      const idx = stack.findIndex((r) => r.id === 1)
      if (idx >= 0) stack.splice(idx, 1)
      stack.push(makeReg(3, "enter", () => bottomFires++))
    })
    stack.push(bottom, top)

    const evt = makeEvt("return")
    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(true)
    expect(topFires).toBe(1)
    expect(bottomFires).toBe(0)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("re-entrant dispatch from inside cmd() is dropped (one keypress, one binding)", () => {
    let outerFires = 0
    let innerFires = 0
    const stack: RegisteredBinding[] = []
    const inner = makeReg(1, "enter", () => {
      innerFires++
    })
    const outer = makeReg(2, "enter", () => {
      outerFires++
      dispatchKeyEvent(stack, makeEvt("return"))
    })
    stack.push(inner, outer)

    const evt = makeEvt("return")
    const handled = dispatchKeyEvent(stack, evt)

    expect(handled).toBe(true)
    expect(outerFires).toBe(1)
    expect(innerFires).toBe(0)
    expect(evt.defaultPrevented).toBe(true)
  })

  test("the re-entrancy guard resets between independent dispatches", () => {
    let fires = 0
    const stack: RegisteredBinding[] = [
      makeReg(1, "enter", () => {
        fires++
      }),
    ]

    dispatchKeyEvent(stack, makeEvt("return"))
    dispatchKeyEvent(stack, makeEvt("return"))

    expect(fires).toBe(2)
  })

  test("legacy ctrl+h (raw 0x08 backspace) fires a ctrl+h binding", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+h", () => {
        fired = true
      }),
    ]
    const evt = makeEvt("backspace", { raw: "\b" })

    expect(dispatchKeyEvent(stack, evt)).toBe(true)
    expect(fired).toBe(true)
  })

  test("the real Backspace key (raw 0x7f) does NOT fire a ctrl+h binding", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+h", () => {
        fired = true
      }),
    ]
    const evt = makeEvt("backspace", { raw: "\x7f" })

    expect(dispatchKeyEvent(stack, evt)).toBe(false)
    expect(fired).toBe(false)
  })

  test("legacy ctrl+j (parsed as linefeed) fires a ctrl+j binding", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+j", () => {
        fired = true
      }),
    ]
    const evt = makeEvt("linefeed", { raw: "\n" })

    expect(dispatchKeyEvent(stack, evt)).toBe(true)
    expect(fired).toBe(true)
  })

  test("meta variants (esc-prefixed backspace/linefeed) do not alias to ctrl chords", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "ctrl+h", () => {
        fired = true
      }),
      makeReg(2, "ctrl+j", () => {
        fired = true
      }),
    ]

    expect(dispatchKeyEvent(stack, makeEvt("backspace", { raw: "\x1b\b", meta: true }))).toBe(false)
    expect(dispatchKeyEvent(stack, makeEvt("linefeed", { raw: "\x1b\n", meta: true }))).toBe(false)
    expect(fired).toBe(false)
  })

  test("a legacy-aliased event still matches a plain backspace binding (candidates coexist)", () => {
    let fired = false
    const stack: RegisteredBinding[] = [
      makeReg(1, "backspace", () => {
        fired = true
      }),
    ]

    expect(dispatchKeyEvent(stack, makeEvt("backspace", { raw: "\b" }))).toBe(true)
    expect(fired).toBe(true)
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
            { key: "w", cmd, slot: 1 },
          ],
        }),
      },
    ]

    dispatchKeyEvent(stack, makeEvt("w"))

    expect(seen).toEqual([0])
  })
})
