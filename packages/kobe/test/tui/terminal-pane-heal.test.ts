/**
 * Pure-policy tests for the kobe-owned pane heal machinery
 * (`src/tui/panes/terminal/pane-heal.ts`).
 *
 * Only the WHICH-panes policy is exercised — listing/respawning panes
 * needs a live tmux server and is verified interactively. These tests
 * matter because the heal plan decides which long-lived processes get
 * KILLED and respawned in place: a wrong filter either leaves a pane on
 * stale code after an upgrade (the v0.x "new shortcut is missing" class
 * of bug) or kills the user's engine pane mid-turn.
 */

import { describe, expect, test } from "vitest"
import {
  type KobePaneRow,
  paneIdsByRole,
  parseKobePaneRows,
  planPaneHeals,
} from "../../src/tui/panes/terminal/pane-heal"

const row = (windowId: string, paneId: string, role: string, version: string): KobePaneRow => ({
  windowId,
  paneId,
  role,
  version,
})

describe("parseKobePaneRows", () => {
  test("parses the 4-field window/pane/role/version listing", () => {
    expect(parseKobePaneRows("@1\t%0\tclaude\t0.7.0\n@1\t%1\ttasks\t0.7.0\n")).toEqual([
      row("@1", "%0", "claude", "0.7.0"),
      row("@1", "%1", "tasks", "0.7.0"),
    ])
  })

  test("defaults a missing version field to the empty string (pre-tag pane)", () => {
    expect(parseKobePaneRows("@1\t%1\ttasks\t")).toEqual([row("@1", "%1", "tasks", "")])
  })

  test("drops blank lines and rows without a role tag (user shell panes)", () => {
    // The shell pane carries no @kobe_role, so its 3rd field is empty.
    expect(parseKobePaneRows("@1\t%3\t\t\n\n@1\t%1\ttasks\t0.7.0")).toEqual([row("@1", "%1", "tasks", "0.7.0")])
  })

  test("trims whitespace around every field", () => {
    expect(parseKobePaneRows(" @1\t %1 \t tasks \t 0.7.0 ")).toEqual([row("@1", "%1", "tasks", "0.7.0")])
  })

  test("parses the geometry-extended 5th field (pane width) when present", () => {
    // The combined heal snapshot rides pane_width on the same listing so the
    // rail-width heal doesn't need its own list-panes spawn.
    expect(parseKobePaneRows("@1\t%1\ttasks\t0.7.0\t18")).toEqual([
      { ...row("@1", "%1", "tasks", "0.7.0"), paneWidth: 18 },
    ])
    // An unparsable width is OMITTED (compares unequal to any target → heals).
    expect(parseKobePaneRows("@1\t%1\ttasks\t0.7.0\t")).toEqual([row("@1", "%1", "tasks", "0.7.0")])
  })
})

describe("paneIdsByRole", () => {
  const rows = [
    row("@1", "%0", "claude", "1"),
    row("@1", "%1", "tasks", "1"),
    row("@2", "%4", "claude", "1"),
    row("@2", "%5", "ops", "1"),
  ]

  test("selects only panes carrying the requested role, in listing order", () => {
    expect(paneIdsByRole(rows, "claude")).toEqual(["%0", "%4"])
    expect(paneIdsByRole(rows, "tasks")).toEqual(["%1"])
  })

  test("returns empty for an absent role instead of falling back", () => {
    expect(paneIdsByRole(rows, "shell")).toEqual([])
  })
})

describe("planPaneHeals — stale-only (the upgrade heal)", () => {
  const opts = { currentVersion: "0.8.0", force: false }

  test("respawns only panes whose version tag is stale or absent", () => {
    const rows = [
      row("@1", "%0", "claude", ""),
      row("@1", "%1", "tasks", "0.7.0"),
      row("@1", "%2", "ops", ""),
      row("@2", "%4", "claude", ""),
      row("@2", "%5", "tasks", "0.8.0"),
      row("@2", "%6", "ops", "0.8.0"),
    ]
    expect(planPaneHeals(rows, opts)).toEqual([
      { role: "tasks", paneId: "%1" },
      { role: "ops", paneId: "%2", claudePaneId: "%0" },
    ])
  })

  test("never targets the engine or untagged shell panes", () => {
    const rows = [row("@1", "%0", "claude", ""), row("@1", "%3", "shell", "")]
    expect(planPaneHeals(rows, opts)).toEqual([])
  })

  test("skips a stale Ops pane in a window with no live claude pane to target", () => {
    const rows = [row("@1", "%2", "ops", "0.7.0"), row("@1", "%1", "tasks", "0.7.0")]
    expect(planPaneHeals(rows, opts)).toEqual([{ role: "tasks", paneId: "%1" }])
  })

  test("pairs each Ops pane with its OWN window's claude pane", () => {
    const rows = [
      row("@1", "%0", "claude", ""),
      row("@1", "%2", "ops", "old"),
      row("@2", "%4", "claude", ""),
      row("@2", "%6", "ops", "old"),
    ]
    expect(planPaneHeals(rows, opts)).toEqual([
      { role: "ops", paneId: "%2", claudePaneId: "%0" },
      { role: "ops", paneId: "%6", claudePaneId: "%4" },
    ])
  })
})

describe("planPaneHeals — force (the settings refresh)", () => {
  const opts = { currentVersion: "0.8.0", force: true }

  test("respawns every Tasks/Ops pane regardless of version", () => {
    const rows = [row("@1", "%0", "claude", ""), row("@1", "%1", "tasks", "0.8.0"), row("@1", "%2", "ops", "0.8.0")]
    expect(planPaneHeals(rows, opts)).toEqual([
      { role: "tasks", paneId: "%1" },
      { role: "ops", paneId: "%2", claudePaneId: "%0" },
    ])
  })

  test("respawns the Ops pane of a degraded window (no claude pane) with a null target", () => {
    // A `kobe reload` must not silently leave this Ops pane on stale code;
    // opsPaneCommand degrades to its git-status fallback for a null target.
    const rows = [row("@1", "%2", "ops", "0.8.0")]
    expect(planPaneHeals(rows, opts)).toEqual([{ role: "ops", paneId: "%2", claudePaneId: null }])
  })

  test("still ignores engine and untagged panes", () => {
    const rows = [row("@1", "%0", "claude", "")]
    expect(planPaneHeals(rows, opts)).toEqual([])
  })
})
