/** Prefix/terminal boundary regressions kept separate from the legacy dispatcher suite. */

import type { KeyEvent } from "@opentui/core"
import { beforeEach, describe, expect, test } from "vitest"
import {
  type RegisteredBinding,
  bindingReachability,
  dispatchKeyEvent,
  resetPrefixState,
} from "../../src/tui/lib/keymap-dispatch"
import { prefixHudState, resetPrefixHud } from "../../src/tui/lib/prefix-hud"

function makeEvt(name: string, mods: Partial<KeyEvent> = {}): KeyEvent & { defaultPrevented: boolean } {
  const evt = {
    name,
    sequence: name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    eventType: "press",
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
    ...mods,
  }
  return evt as KeyEvent & { defaultPrevented: boolean }
}

beforeEach(() => {
  resetPrefixState()
  resetPrefixHud()
})

describe("prefix passthrough boundary", () => {
  test("terminal passthrough owns the configurable prefix first stroke", () => {
    let forwarded = false
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({
          bindings: [{ key: "f", prefix: true, cmd: () => {}, id: "chat.fork.new" }],
        }),
      },
      {
        id: 2,
        config: () => ({
          bindings: [
            {
              key: "ctrl+a",
              passthrough: true,
              cmd: () => {
                forwarded = true
              },
            },
          ],
        }),
      },
    ]

    const evt = makeEvt("a", { ctrl: true })
    expect(dispatchKeyEvent(stack, evt, 100)).toBe(true)
    expect(forwarded).toBe(true)
    expect(evt.defaultPrevented).toBe(true)
    expect(prefixHudState().armed).toBe(false)
    expect(prefixHudState().entries).toHaveLength(0)
    expect(bindingReachability(stack).inputPassthrough).toBe(true)
  })

  test("entering terminal input cancels a prefix armed in another pane", () => {
    let prefixFired = false
    let forwarded = false
    const global: RegisteredBinding = {
      id: 1,
      config: () => ({
        bindings: [
          {
            key: "f",
            prefix: true,
            id: "chat.fork.new",
            cmd: () => {
              prefixFired = true
            },
          },
        ],
      }),
    }

    expect(dispatchKeyEvent([global], makeEvt("a", { ctrl: true }), 100)).toBe(true)
    expect(prefixHudState().armed).toBe(true)

    const terminal: RegisteredBinding = {
      id: 2,
      config: () => ({
        bindings: [
          {
            key: "f",
            passthrough: true,
            cmd: () => {
              forwarded = true
            },
          },
        ],
      }),
    }
    expect(dispatchKeyEvent([global, terminal], makeEvt("f"), 200)).toBe(true)
    expect(forwarded).toBe(true)
    expect(prefixFired).toBe(false)
    expect(prefixHudState().armed).toBe(false)
    expect(prefixHudState().entries).toHaveLength(0)
  })
})
