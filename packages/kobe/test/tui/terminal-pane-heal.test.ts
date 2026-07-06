import { describe, expect, test } from "vitest"
import {
  type KobePaneRow,
  classifyRelaunchOutcome,
  commandTargetPane,
  dropCommandsForVanishedPanes,
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
    expect(parseKobePaneRows("@1\t%3\t\t\n\n@1\t%1\ttasks\t0.7.0")).toEqual([row("@1", "%1", "tasks", "0.7.0")])
  })

  test("trims whitespace around every field", () => {
    expect(parseKobePaneRows(" @1\t %1 \t tasks \t 0.7.0 ")).toEqual([row("@1", "%1", "tasks", "0.7.0")])
  })

  test("parses the geometry-extended 5th field (pane width) when present", () => {
    expect(parseKobePaneRows("@1\t%1\ttasks\t0.7.0\t18")).toEqual([
      { ...row("@1", "%1", "tasks", "0.7.0"), paneWidth: 18 },
    ])
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

describe("planPaneHeals — vendorChanged (the in-place engine switch, KOB-232)", () => {
  const opts = { currentVersion: "0.8.0", force: false, vendorChanged: true }

  test("respawns the Ops pane even when its version matches (force the new --vendor)", () => {
    const rows = [
      row("@1", "%0", "claude", "0.8.0"),
      row("@1", "%1", "tasks", "0.8.0"),
      row("@1", "%2", "ops", "0.8.0"),
    ]
    expect(planPaneHeals(rows, opts)).toEqual([{ role: "ops", paneId: "%2", claudePaneId: "%0" }])
  })

  test("respawns the Ops pane in EVERY window (sibling chat tabs all switch)", () => {
    const rows = [
      row("@1", "%0", "claude", "0.8.0"),
      row("@1", "%2", "ops", "0.8.0"),
      row("@2", "%4", "claude", "0.8.0"),
      row("@2", "%6", "ops", "0.8.0"),
    ]
    expect(planPaneHeals(rows, opts)).toEqual([
      { role: "ops", paneId: "%2", claudePaneId: "%0" },
      { role: "ops", paneId: "%6", claudePaneId: "%4" },
    ])
  })

  test("still skips an Ops pane in a window with no live claude pane (nothing to target)", () => {
    const rows = [row("@1", "%2", "ops", "0.8.0"), row("@1", "%1", "tasks", "0.8.0")]
    expect(planPaneHeals(rows, opts)).toEqual([])
  })

  test("does NOT force the Tasks rail (vendor-agnostic) — only stale Tasks panes respawn", () => {
    const rows = [
      row("@1", "%0", "claude", "0.8.0"),
      row("@1", "%1", "tasks", "0.7.0"),
      row("@1", "%2", "ops", "0.8.0"),
    ]
    expect(planPaneHeals(rows, opts)).toEqual([
      { role: "tasks", paneId: "%1" },
      { role: "ops", paneId: "%2", claudePaneId: "%0" },
    ])
  })

  test("absent vendorChanged behaves exactly like the stale-only heal", () => {
    const rows = [row("@1", "%0", "claude", "0.8.0"), row("@1", "%2", "ops", "0.8.0")]
    expect(planPaneHeals(rows, { currentVersion: "0.8.0", force: false })).toEqual([])
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
    const rows = [row("@1", "%2", "ops", "0.8.0")]
    expect(planPaneHeals(rows, opts)).toEqual([{ role: "ops", paneId: "%2", claudePaneId: null }])
  })

  test("still ignores engine and untagged panes", () => {
    const rows = [row("@1", "%0", "claude", "")]
    expect(planPaneHeals(rows, opts)).toEqual([])
  })
})

describe("commandTargetPane", () => {
  test("returns the value following the -t flag for each heal command shape", () => {
    expect(commandTargetPane(["respawn-pane", "-k", "-t", "%2", "-c", "/wt", "cmd"])).toBe("%2")
    expect(commandTargetPane(["resize-pane", "-t", "%1", "-x", "18"])).toBe("%1")
    expect(commandTargetPane(["set-option", "-p", "-t", "%2", "@kobe_role", "ops"])).toBe("%2")
    expect(commandTargetPane(["set-window-option", "-t", "%0", "@kobe_session_id", "uuid"])).toBe("%0")
  })

  test("returns null when the command targets no pane (defensive — kept by the filter)", () => {
    expect(commandTargetPane(["refresh-client"])).toBeNull()
    expect(commandTargetPane(["resize-pane", "-t"])).toBeNull()
  })
})

describe("dropCommandsForVanishedPanes", () => {
  const tasksHeal = (id: string): (readonly string[])[] => [
    ["respawn-pane", "-k", "-t", id, "-c", "/wt", "cmd"],
    ["set-option", "-p", "-t", id, "@kobe_role", "tasks"],
    ["set-option", "-p", "-t", id, "@kobe_pane_version", "0.8.0"],
  ]

  test("keeps every command when all target panes still exist", () => {
    const commands = [...tasksHeal("%1"), ...tasksHeal("%5")]
    expect(dropCommandsForVanishedPanes(commands, new Set(["%1", "%5", "%0"]))).toEqual(commands)
  })

  test("drops ALL commands for a vanished pane but keeps the survivors, in order", () => {
    const commands = [...tasksHeal("%1"), ...tasksHeal("%5")]
    expect(dropCommandsForVanishedPanes(commands, new Set(["%5"]))).toEqual(tasksHeal("%5"))
  })

  test("interleaved layout + respawn commands keep their relative order after filtering", () => {
    const commands: (readonly string[])[] = [
      ["resize-pane", "-t", "%1", "-x", "18"],
      ["resize-pane", "-t", "%9", "-x", "40%"],
      ...tasksHeal("%9"),
      ["set-option", "-p", "-t", "%1", "@kobe_role", "tasks"],
    ]
    expect(dropCommandsForVanishedPanes(commands, new Set(["%1"]))).toEqual([
      ["resize-pane", "-t", "%1", "-x", "18"],
      ["set-option", "-p", "-t", "%1", "@kobe_role", "tasks"],
    ])
  })

  test("an empty present-set drops every pane-targeted command", () => {
    expect(dropCommandsForVanishedPanes(tasksHeal("%1"), new Set())).toEqual([])
  })

  test("keeps a command that targets no pane regardless of the present-set", () => {
    const commands: (readonly string[])[] = [["refresh-client"], ...tasksHeal("%1")]
    expect(dropCommandsForVanishedPanes(commands, new Set())).toEqual([["refresh-client"]])
  })
})

describe("classifyRelaunchOutcome", () => {
  test("no engine pane found → rebuild signal, regardless of code", () => {
    expect(classifyRelaunchOutcome(0, 0)).toBe("no-engine-pane")
    expect(classifyRelaunchOutcome(0, 1)).toBe("no-engine-pane")
  })

  test("engine panes found and the batched respawn succeeded → switched", () => {
    expect(classifyRelaunchOutcome(1, 0)).toBe("switched")
    expect(classifyRelaunchOutcome(3, 0)).toBe("switched")
  })

  test("a failed respawn in any window → respawn-failed, so the tag is NOT advanced", () => {
    expect(classifyRelaunchOutcome(3, 1)).toBe("respawn-failed")
    expect(classifyRelaunchOutcome(1, 1)).toBe("respawn-failed")
    expect(classifyRelaunchOutcome(2, 127)).toBe("respawn-failed")
  })
})
