/**
 * Sidebar key wiring (`panes/sidebar/keys.ts`): the dispatch decisions the
 * hook layer owns on top of the pure controller — slot-multiplexed nav
 * (even=down / odd=up so user rebinds keep working), shift discrimination for
 * P/M (the keymap layer drops shift on letters), move-mode rerouting of j/k
 * into reorder requests, and the search-mode gate that de-registers letter
 * chords while `[`/`]` view switching stays live.
 *
 * `useBindings` (the only @opentui-touching import) is mocked to CAPTURE the
 * reactive configs; the test then simulates the keymap dispatcher: evaluate
 * `enabled`, match `key`, call `cmd(evt, slot)`. `bindByIds` + the KobeKeymap
 * chord table + the controller are all REAL — the chords a user actually gets
 * are the ones under test.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"

type CapturedConfig = () => {
  enabled: boolean
  bindings: Array<{ key: string; cmd: (evt: unknown, slot?: number) => void; slot?: number }>
}
const captured: CapturedConfig[] = []

vi.mock("../../src/tui/lib/keymap", () => ({
  useBindings: (config: CapturedConfig) => {
    captured.push(config)
  },
}))

import { useSidebarBindings } from "../../src/tui/panes/sidebar/keys"

function press(key: string, evt: { shift?: boolean } = {}): void {
  for (const config of captured) {
    const c = config()
    if (!c.enabled) continue
    for (const b of c.bindings) {
      if (b.key === key) b.cmd({ shift: evt.shift ?? false }, b.slot)
    }
  }
}

function setup(
  overrides: Partial<Parameters<typeof useSidebarBindings>[0]> & {
    ids?: string[]
    startCursor?: number
  } = {},
) {
  captured.length = 0
  let cursor = overrides.startCursor ?? 0
  const ids = overrides.ids ?? ["t1", "t2", "t3"]
  const handlers = {
    onSelect: vi.fn(),
    onDeleteRequest: vi.fn(),
    onArchiveRequest: vi.fn(),
    onRenameRequest: vi.fn(),
    onPinRequest: vi.fn(),
    onLocalMergeRequest: vi.fn(),
    onPreviewToggleRequest: vi.fn(),
    onViewSwitch: vi.fn(),
    onSortModeToggle: vi.fn(),
    onProjectFilterToggle: vi.fn(),
    onSearchEnter: vi.fn(),
    onSearchExit: vi.fn(),
    onMoveRequest: vi.fn(),
    onMoveModeExit: vi.fn(),
  }
  useSidebarBindings({
    focused: () => true,
    cursorIndex: () => cursor,
    setCursorIndex: (n) => {
      cursor = n
    },
    flatTaskIds: () => ids,
    ...handlers,
    ...overrides,
  })
  return { ...handlers, cursor: () => cursor }
}

beforeEach(() => {
  captured.length = 0
})

describe("navigation dispatch", () => {
  test("j/down move down (even slots), k/up move up (odd slots)", () => {
    const s = setup()
    press("j")
    expect(s.cursor()).toBe(1)
    press("down")
    expect(s.cursor()).toBe(2)
    press("k")
    expect(s.cursor()).toBe(1)
    press("up")
    expect(s.cursor()).toBe(0)
  })

  test("enter selects the task under the cursor", () => {
    const s = setup({ startCursor: 1 })
    press("return")
    expect(s.onSelect).toHaveBeenCalledWith("t2")
  })

  test("gg jumps to top, shift-G to bottom (one `g` chord, shift-discriminated)", () => {
    const s = setup({ startCursor: 2 })
    press("g")
    press("g")
    expect(s.cursor()).toBe(0)
    press("g", { shift: true })
    expect(s.cursor()).toBe(2)
  })
})

describe("action chords", () => {
  test("d/a/r/i fire their request callbacks with the cursor task id", () => {
    const s = setup({ startCursor: 1 })
    press("d")
    expect(s.onDeleteRequest).toHaveBeenCalledWith("t2")
    press("a")
    expect(s.onArchiveRequest).toHaveBeenCalledWith("t2")
    press("r")
    expect(s.onRenameRequest).toHaveBeenCalledWith("t2")
    press("i")
    expect(s.onPreviewToggleRequest).toHaveBeenCalledWith("t2")
  })

  test("action chords are no-ops when the cursor is out of range", () => {
    const s = setup({ ids: [], startCursor: -1 })
    press("d")
    press("a")
    press("r")
    expect(s.onDeleteRequest).not.toHaveBeenCalled()
    expect(s.onArchiveRequest).not.toHaveBeenCalled()
    expect(s.onRenameRequest).not.toHaveBeenCalled()
  })

  test("pin (P) and local-merge (M) require shift — bare lowercase is consumed but inert", () => {
    const s = setup()
    press("p")
    press("m")
    expect(s.onPinRequest).not.toHaveBeenCalled()
    expect(s.onLocalMergeRequest).not.toHaveBeenCalled()
    press("p", { shift: true })
    press("m", { shift: true })
    expect(s.onPinRequest).toHaveBeenCalledWith("t1")
    expect(s.onLocalMergeRequest).toHaveBeenCalledWith("t1")
  })

  test("t cycles sort, ctrl+p cycles project filter, [ and ] switch views", () => {
    const s = setup()
    press("t")
    expect(s.onSortModeToggle).toHaveBeenCalledTimes(1)
    press("ctrl+p")
    expect(s.onProjectFilterToggle).toHaveBeenCalledTimes(1)
    press("[")
    expect(s.onViewSwitch).toHaveBeenCalledWith(-1)
    press("]")
    expect(s.onViewSwitch).toHaveBeenCalledWith(1)
  })
})

describe("search mode", () => {
  test("/ enters search; while searching, letter chords are dead but [/] stay live", () => {
    let searching = false
    const s = setup({ searchMode: () => searching })
    press("/")
    expect(s.onSearchEnter).toHaveBeenCalledTimes(1)

    searching = true
    press("j") // must NOT move the cursor — it's literal input now
    press("d")
    expect(s.cursor()).toBe(0)
    expect(s.onDeleteRequest).not.toHaveBeenCalled()
    press("]")
    expect(s.onViewSwitch).toHaveBeenCalledWith(1)
  })

  test("search nav uses down/up; enter commits (select+exit true); esc cancels (exit false)", () => {
    const s = setup({ searchMode: () => true, startCursor: 0 })
    press("down")
    expect(s.cursor()).toBe(1)
    press("up")
    expect(s.cursor()).toBe(0)
    press("return")
    expect(s.onSelect).toHaveBeenCalledWith("t1")
    expect(s.onSearchExit).toHaveBeenCalledWith(true)
    press("escape")
    expect(s.onSearchExit).toHaveBeenCalledWith(false)
  })
})

describe("move (reorder) mode", () => {
  test("j/k become reorder requests instead of cursor moves", () => {
    const s = setup({ moveMode: () => true, startCursor: 1 })
    press("j")
    expect(s.onMoveRequest).toHaveBeenCalledWith("t2", 1)
    press("k")
    expect(s.onMoveRequest).toHaveBeenCalledWith("t2", -1)
    expect(s.cursor()).toBe(1) // cursor itself never moved
  })

  test("enter and escape both exit move mode", () => {
    const s = setup({ moveMode: () => true })
    press("return")
    expect(s.onMoveModeExit).toHaveBeenCalledTimes(1)
    press("escape")
    expect(s.onMoveModeExit).toHaveBeenCalledTimes(2)
    expect(s.onSelect).not.toHaveBeenCalled()
  })

  test("action chords are gated off during move mode", () => {
    const s = setup({ moveMode: () => true })
    press("d")
    press("a")
    press("r")
    press("g")
    press("/")
    expect(s.onDeleteRequest).not.toHaveBeenCalled()
    expect(s.onArchiveRequest).not.toHaveBeenCalled()
    expect(s.onRenameRequest).not.toHaveBeenCalled()
    expect(s.onSearchEnter).not.toHaveBeenCalled()
  })
})

describe("focus gate", () => {
  test("nothing fires when the sidebar is not focused", () => {
    const s = setup({ focused: () => false })
    press("j")
    press("return")
    press("d")
    press("]")
    expect(s.cursor()).toBe(0)
    expect(s.onSelect).not.toHaveBeenCalled()
    expect(s.onDeleteRequest).not.toHaveBeenCalled()
    expect(s.onViewSwitch).not.toHaveBeenCalled()
  })
})
