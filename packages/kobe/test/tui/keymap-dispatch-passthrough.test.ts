/** Prefix/terminal boundary regressions kept separate from the legacy dispatcher suite. */

import type { KeyEvent } from "@opentui/core"
import { beforeEach, describe, expect, test } from "vitest"
import {
  type RegisteredBinding,
  bindingReachability,
  configurePrefix,
  dispatchKeyEvent,
  resetPrefixConfiguration,
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
  resetPrefixConfiguration()
  resetPrefixState()
  resetPrefixHud()
})

describe("prefix passthrough boundary", () => {
  test("the configured prefix owns its first and second strokes inside terminal passthrough", () => {
    let prefixFired = false
    let forwarded = false
    const stack: RegisteredBinding[] = [
      {
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
            {
              key: "f",
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
    expect(forwarded).toBe(false)
    expect(evt.defaultPrevented).toBe(true)
    expect(prefixHudState().armed).toBe(true)
    expect(bindingReachability(stack).inputPassthrough).toBe(true)

    expect(dispatchKeyEvent(stack, makeEvt("f"), 200)).toBe(true)
    expect(prefixFired).toBe(true)
    expect(forwarded).toBe(false)
    expect(prefixHudState().armed).toBe(false)
    expect(prefixHudState().entries[0]?.action).toBe("chat.fork.new")
  })

  test("live prefix reconfiguration releases the old chord and owns the new one", () => {
    configurePrefix({ key: "ctrl+x", timeoutMs: 5000 })
    const forwarded: string[] = []
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({ bindings: [{ key: "f", prefix: true, cmd: () => {}, id: "chat.fork.new" }] }),
      },
      {
        id: 2,
        config: () => ({
          bindings: ["ctrl+a", "ctrl+x"].map((key) => ({
            key,
            passthrough: true,
            cmd: () => forwarded.push(key),
          })),
        }),
      },
    ]

    expect(dispatchKeyEvent(stack, makeEvt("a", { ctrl: true }), 100)).toBe(true)
    expect(forwarded).toEqual(["ctrl+a"])
    expect(prefixHudState().armed).toBe(false)

    expect(dispatchKeyEvent(stack, makeEvt("x", { ctrl: true }), 200)).toBe(true)
    expect(forwarded).toEqual(["ctrl+a"])
    expect(prefixHudState().armed).toBe(true)
  })

  test("disabling the prefix releases its former first stroke to the terminal", () => {
    configurePrefix({ key: null, timeoutMs: 5000 })
    let forwarded = false
    const stack: RegisteredBinding[] = [
      {
        id: 1,
        config: () => ({ bindings: [{ key: "f", prefix: true, cmd: () => {}, id: "chat.fork.new" }] }),
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

    expect(dispatchKeyEvent(stack, makeEvt("a", { ctrl: true }), 100)).toBe(true)
    expect(forwarded).toBe(true)
    expect(prefixHudState().armed).toBe(false)
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
