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
 * `legendCap` / `legendRowCap`, which live in the framework-free
 * `src/tui/lib/help-groups.ts` — imported here directly (no opentui in the
 * module graph), so this file tests the REAL helpers the footer legend
 * (tasks-pane/shortcut-hints.tsx) and the help dialog run. Two things lock:
 *   1. every binding id the legend reads still EXISTS in KobeKeymap and
 *      resolves to the expected default cap (id drift = a silently-dropped
 *      legend row), and
 *   2. the resolution rule (`hint?.keys ?? keys[0]`, drop on unbind, join
 *      composites with `/`) tracks a real override / unbind through the
 *      live-reload machinery (applyKeymapOverrides + resetKeymapToDefaults).
 */

import { afterEach, describe, expect, test } from "vitest"
import { KobeKeymap, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { legendCap, legendRowCap } from "../../src/tui/lib/help-groups"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

// The id → expected-default-cap map the legend rows are built from. Keep in
// sync with `defaultHints` in tasks-pane/shortcut-hints.tsx (footer rows) —
// the extras here are F1-help rows sharing the same derivation.
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
