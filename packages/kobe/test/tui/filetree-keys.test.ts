/**
 * useFileTreeBindings — the slot-multiplexed dispatch for the file tree's
 * chords. `useBindings` (the opentui-touching registration layer) is mocked
 * to capture the binding table; `bindByIds` runs REAL against KobeKeymap so
 * the ids used here must actually exist. What's pinned: each id maps to the
 * right controller action, and the direction ids dispatch on the SLOT
 * parity (even → down/collapse/prev-tab, odd → up/expand/next-tab) — the
 * property that makes them user-rebindable.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"
import type { KeyEvent } from "../../src/tui/lib/keymap"

const captured = vi.hoisted(() => ({
  config: null as null | (() => { enabled: boolean; bindings: unknown }),
}))

vi.mock("../../src/tui/lib/keymap", () => ({
  useBindings: vi.fn((config: () => { enabled: boolean; bindings: unknown }) => {
    captured.config = config
  }),
}))

const { TAB_ORDER, useFileTreeBindings } = await import("../../src/tui/panes/filetree/keys")

type Handler = (evt: KeyEvent, slot?: number) => void

function makeController() {
  return {
    focused: () => true,
    moveDown: vi.fn(),
    moveUp: vi.fn(),
    setTab: vi.fn(),
    currentTab: vi.fn(() => "all" as const),
    openCurrent: vi.fn(),
    mentionCurrent: vi.fn(),
    createPR: vi.fn(),
    openExternal: vi.fn(),
    refresh: vi.fn(),
    expandOrDescend: vi.fn(),
    collapseOrParent: vi.fn(),
  }
}

/** bindByIds flattens to one { key, cmd, slot } entry PER CHORD — index by key. */
function bindingsFor(ctrl: ReturnType<typeof makeController>): Map<string, { cmd: Handler; slot?: number }> {
  useFileTreeBindings(ctrl)
  const cfg = captured.config?.()
  expect(cfg?.enabled).toBe(true)
  const bindings = cfg?.bindings as ReadonlyArray<{ key: string; cmd: Handler; slot?: number }>
  return new Map(bindings.map((b) => [b.key, { cmd: b.cmd, slot: b.slot }]))
}

function press(map: Map<string, { cmd: Handler; slot?: number }>, key: string): void {
  const b = map.get(key)
  expect(b, `no binding registered for key "${key}"`).toBeDefined()
  b?.cmd(evt, b.slot)
}

const evt = {} as KeyEvent

beforeEach(() => {
  captured.config = null
  vi.clearAllMocks()
})

describe("useFileTreeBindings", () => {
  test("registers real chords from KobeKeymap (bindByIds ran for real)", () => {
    const ctrl = makeController()
    const keys = [...bindingsFor(ctrl).keys()]
    // spot-check the documented defaults are all bound
    expect(keys).toEqual(expect.arrayContaining(["j", "k", "h", "l", "[", "]", "r"]))
  })

  test("files.nav slot parity: j/down → down, k/up → up", () => {
    const ctrl = makeController()
    const h = bindingsFor(ctrl)
    press(h, "j")
    press(h, "down")
    expect(ctrl.moveDown).toHaveBeenCalledTimes(2)
    press(h, "k")
    press(h, "up")
    expect(ctrl.moveUp).toHaveBeenCalledTimes(2)
  })

  test("files.hierarchy slot parity: h → collapse/parent, l → expand/descend", () => {
    const ctrl = makeController()
    const h = bindingsFor(ctrl)
    press(h, "h")
    expect(ctrl.collapseOrParent).toHaveBeenCalledTimes(1)
    press(h, "l")
    expect(ctrl.expandOrDescend).toHaveBeenCalledTimes(1)
  })

  test("files.tab cycles TAB_ORDER with wrap-around in both directions", () => {
    const ctrl = makeController()
    const h = bindingsFor(ctrl)
    // current=all (index 0); [ → previous → wraps to the last tab
    press(h, "[")
    expect(ctrl.setTab).toHaveBeenLastCalledWith(TAB_ORDER[TAB_ORDER.length - 1])
    // ] → next
    press(h, "]")
    expect(ctrl.setTab).toHaveBeenLastCalledWith(TAB_ORDER[1 % TAB_ORDER.length])
  })

  test("files.tab no-ops when the current tab isn't in TAB_ORDER", () => {
    const ctrl = makeController()
    ctrl.currentTab.mockReturnValue("bogus" as unknown as (typeof TAB_ORDER)[number])
    const h = bindingsFor(ctrl)
    press(h, "]")
    expect(ctrl.setTab).not.toHaveBeenCalled()
  })

  test("action chords map straight to their controller calls, optional ones tolerate absence", () => {
    const ctrl = makeController()
    const h = bindingsFor(ctrl)
    press(h, "r")
    expect(ctrl.refresh).toHaveBeenCalled()
    press(h, "a")
    expect(ctrl.mentionCurrent).toHaveBeenCalled()
    press(h, "p")
    expect(ctrl.createPR).toHaveBeenCalled()

    // Ops-host-only callbacks omitted → the handlers are safe no-ops.
    const bare = { ...makeController(), mentionCurrent: undefined, createPR: undefined }
    const h2 = bindingsFor(bare as unknown as ReturnType<typeof makeController>)
    expect(() => {
      h2.get("a")?.cmd(evt, h2.get("a")?.slot)
      h2.get("p")?.cmd(evt, h2.get("p")?.slot)
    }).not.toThrow()
  })
})
