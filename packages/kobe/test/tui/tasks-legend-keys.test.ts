/**
 * Tasks-pane footer legend keycap derivation (bug-4).
 *
 * The footer `── keys ──` legend is the ONLY always-visible keybinding
 * surface (the outer monitor's status bar is gone). docs/KEYBINDINGS.md
 * promises every surface follows the keymap: "one mutation re-points every
 * surface — chord, Help copy, and footer hint follow automatically
 * (overridden rows get their hint.keys refreshed; an unbound row loses its
 * hint)". The legend rows used to be a hardcoded literal array
 * (`{ k: "n" }`, `{ k: "a/d" }`, …) so an override / unbind in
 * ~/.kobe/settings/keybindings.yaml changed dispatch but NOT the advertised
 * cap — the legend lied. The fix derives each cap from `KobeKeymap` via
 * `legendCap` / `legendRowCap` in tasks-pane/host.tsx.
 *
 * Why this test pins the keymap CONTRACT rather than importing the host's
 * `legendCap`: tasks-pane/host.tsx pulls in `@opentui/core` at module-eval
 * (the Sidebar / dimensions graph), which crashes vitest on a `.scm` asset —
 * pane hosts aren't CI-importable (same reason tasks-focus-engine.test.ts
 * pins the row contract, not the host). So we lock the two things the
 * derivation depends on:
 *   1. every binding id the legend reads still EXISTS in KobeKeymap and
 *      resolves to the expected default cap (id drift = a silently-dropped
 *      legend row), and
 *   2. the resolution rule (`hint?.keys ?? keys[0]`, drop on unbind, join
 *      composites with `/`) tracks a real override / unbind through the
 *      live-reload machinery (applyKeymapOverrides + resetKeymapToDefaults).
 *
 * The rule mirror below is the EXACT body of host.tsx's `legendCap` /
 * `legendRowCap`; if you change one, change the other (they can't share a
 * module without dragging opentui into the test).
 */

import { afterEach, describe, expect, test } from "vitest"
import { KobeKeymap, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

// Mirror of tasks-pane/host.tsx `legendCap`.
function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = row.hint?.keys ?? row.keys[0]
  return cap && cap.length > 0 ? cap : null
}

// Mirror of tasks-pane/host.tsx `legendRowCap`.
function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}

// The id → expected-default-cap map the legend rows in host.tsx are built
// from. Keep in sync with `defaultHints` in tasks-pane/host.tsx.
const SINGLE_ROWS: ReadonlyArray<readonly [id: string, cap: string]> = [
  ["sidebar.select", "enter"], // "open"
  ["tasks.focusEngine", "→"], // "focus engine"
  ["task.new", "n"], // "new task"
  ["settings.open.sidebar", "s"], // "settings"
  ["tasks.openWorktree", "o"], // "open wt"
  ["sidebar.view", "[/]"], // "views"
  ["sidebar.sort", "t"], // "sort"
  ["sidebar.localMerge", "M"], // "move task"
  ["help.open", "F1"], // "help"
]
const COMPOSITE_ROWS: ReadonlyArray<readonly [ids: readonly string[], cap: string]> = [
  [["sidebar.archive", "sidebar.delete"], "a/d"], // "un/archive·delete"
  [["sidebar.rename", "tasks.renameBranch", "tasks.cycleEngine"], "r/b/v"], // "name/branch/engine"
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
    // task.new: c — a bare-letter sidebar override is valid (scope:"sidebar").
    applyKeymapOverrides(KobeKeymap, [{ id: "task.new", keys: ["c"] }])
    expect(legendCap("task.new")).toBe("c")
    resetKeymapToDefaults()
    expect(legendCap("task.new")).toBe("n")
  })

  test("a composite row drops only the unbound id, keeping the survivors", () => {
    // Unbind the branch rename (b) — the r/b/v row collapses to r/v, it
    // does not advertise the dead `b`.
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
