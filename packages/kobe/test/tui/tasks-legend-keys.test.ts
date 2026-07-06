import { afterEach, describe, expect, test } from "vitest"
import { KobeKeymap, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = row.hint?.keys ?? row.keys[0]
  return cap && cap.length > 0 ? cap : null
}

function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}

const SINGLE_ROWS: ReadonlyArray<readonly [id: string, cap: string]> = [
  ["sidebar.select", "enter"],
  ["tasks.focusEngine", "→"],
  ["task.new", "n"],
  ["settings.open.sidebar", "s"],
  ["tasks.openWorktree", "o"],
  ["sidebar.view", "[/]"],
  ["sidebar.sort", "t"],
  ["sidebar.localMerge", "M"],
  ["help.open", "F1"],
]
const COMPOSITE_ROWS: ReadonlyArray<readonly [ids: readonly string[], cap: string]> = [
  [["sidebar.archive", "sidebar.delete"], "a/d"],
  [["sidebar.rename", "tasks.renameBranch", "tasks.cycleEngine"], "r/b/v"],
]

describe("tasks-pane legend keycap derivation", () => {
  afterEach(() => resetKeymapToDefaults())

  test("every legend id exists in KobeKeymap (no silently-dropped rows)", () => {
    const all = [...SINGLE_ROWS.map(([id]) => id), ...COMPOSITE_ROWS.flatMap(([ids]) => ids)]
    for (const id of all) {
      expect(findBinding(id), `legend reads binding id "${id}" — keep it in KobeKeymap`).toBeDefined()
    }
  })

  test("default caps match the hardcoded captions the legend replaced", () => {
    for (const [id, cap] of SINGLE_ROWS) {
      expect(legendCap(id), id).toBe(cap)
    }
    for (const [ids, cap] of COMPOSITE_ROWS) {
      expect(legendRowCap(ids), ids.join("+")).toBe(cap)
    }
  })

  test("an override re-points the cap (hint.keys is refreshed in place)", () => {
    applyKeymapOverrides(KobeKeymap, [{ id: "task.new", keys: ["c"] }])
    expect(legendCap("task.new")).toBe("c")
    resetKeymapToDefaults()
    expect(legendCap("task.new")).toBe("n")
  })

  test("a composite row drops only the unbound id, keeping the survivors", () => {
    applyKeymapOverrides(KobeKeymap, [{ id: "tasks.renameBranch", keys: [] }])
    expect(legendCap("tasks.renameBranch")).toBeNull()
    expect(legendRowCap(["sidebar.rename", "tasks.renameBranch", "tasks.cycleEngine"])).toBe("r/v")
  })

  test("a fully-unbound row resolves to null so the caller drops it entirely", () => {
    applyKeymapOverrides(KobeKeymap, [{ id: "tasks.openWorktree", keys: [] }])
    expect(legendCap("tasks.openWorktree")).toBeNull()
    expect(legendRowCap(["tasks.openWorktree"])).toBeNull()
  })

  test("unknown id resolves to null (typo drops its row, never throws)", () => {
    expect(legendCap("tasks.doesNotExist")).toBeNull()
    expect(legendRowCap(["tasks.doesNotExist"])).toBeNull()
  })
})
