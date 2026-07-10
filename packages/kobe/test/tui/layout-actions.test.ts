/**
 * Pure tests for the tmux layout action policy. The live actions shell out to
 * tmux, but their safety hinges on small deterministic choices: which pane gets
 * split for the 2/3/4-pane templates, how old untagged shell panes are found,
 * and how hidden pane helper sessions/slots are named.
 */

import { describe, expect, test } from "vitest"
import { hiddenTerminalSessionName, hiddenTerminalWindowIndex } from "../../src/tmux/session-layout"
import {
  expandedTerminalHeightPercent,
  parseLayoutPaneRows,
  planWorkspaceSplit,
  resolveShellPane,
} from "../../src/tui/panes/terminal/layout-plan"

describe("parseLayoutPaneRows", () => {
  test("parses the active-window tmux listing", () => {
    expect(parseLayoutPaneRows("%1\tclaude\t1\t80\t20\t160\t40\n%2\tworkspace_aux\t0\t80\t20\t160\t40")).toEqual([
      {
        paneId: "%1",
        role: "claude",
        active: true,
        paneWidth: 80,
        paneHeight: 20,
        windowWidth: 160,
        windowHeight: 40,
      },
      {
        paneId: "%2",
        role: "workspace_aux",
        active: false,
        paneWidth: 80,
        paneHeight: 20,
        windowWidth: 160,
        windowHeight: 40,
      },
    ])
  })
})

describe("planWorkspaceSplit", () => {
  const engine = {
    paneId: "%1",
    role: "claude",
    active: true,
    paneWidth: 80,
    paneHeight: 40,
    windowWidth: 160,
    windowHeight: 40,
  }
  const aux1 = {
    paneId: "%2",
    role: "workspace_aux",
    active: false,
    paneWidth: 40,
    paneHeight: 40,
    windowWidth: 160,
    windowHeight: 40,
  }
  const aux2 = {
    paneId: "%3",
    role: "workspace_aux",
    active: false,
    paneWidth: 40,
    paneHeight: 20,
    windowWidth: 160,
    windowHeight: 40,
  }
  const aux3 = {
    paneId: "%4",
    role: "workspace_aux",
    active: false,
    paneWidth: 40,
    paneHeight: 20,
    windowWidth: 160,
    windowHeight: 40,
  }

  test("1→2 splits the engine horizontally", () => {
    expect(planWorkspaceSplit([engine])).toEqual({ kind: "split", targetPane: "%1", direction: "-h" })
  })

  test("2→3 splits the first aux vertically to make a right-side stack", () => {
    expect(planWorkspaceSplit([engine, aux1])).toEqual({ kind: "split", targetPane: "%2", direction: "-v" })
  })

  test("3→4 splits the engine vertically to make a 2x2 grid", () => {
    expect(planWorkspaceSplit([engine, aux1, aux2])).toEqual({ kind: "split", targetPane: "%1", direction: "-v" })
  })

  test("refuses to exceed four middle panes", () => {
    expect(planWorkspaceSplit([engine, aux1, aux2, aux3])).toEqual({ kind: "maxed" })
  })

  test("requires a tagged engine pane", () => {
    expect(planWorkspaceSplit([aux1])).toEqual({ kind: "missing-engine" })
  })
})

describe("resolveShellPane", () => {
  test("prefers a tagged shell pane, but accepts the old untagged shell fallback", () => {
    const tagged = {
      paneId: "%5",
      role: "shell",
      active: false,
      paneWidth: 40,
      paneHeight: 10,
      windowWidth: 160,
      windowHeight: 40,
    }
    const old = {
      paneId: "%6",
      role: "",
      active: false,
      paneWidth: 40,
      paneHeight: 10,
      windowWidth: 160,
      windowHeight: 40,
    }
    expect(resolveShellPane([old, tagged])?.paneId).toBe("%5")
    expect(resolveShellPane([old])?.paneId).toBe("%6")
  })
})

describe("expandedTerminalHeightPercent", () => {
  test("restores the terminal to the space left below the Ops pane", () => {
    expect(expandedTerminalHeightPercent(60)).toBe(40)
  })

  test("falls back to the default split when the stored Ops height is invalid", () => {
    expect(expandedTerminalHeightPercent()).toBe(50)
  })
})

describe("hidden terminal helpers", () => {
  test("derives a safe helper session name from the task session", () => {
    expect(hiddenTerminalSessionName("kobe-a.b:c/d e")).toBe("kobe-hidden-kobe-abcde")
  })

  test("derives a stable high window index from the active tmux window id", () => {
    expect(hiddenTerminalWindowIndex("@42")).toBe(1042)
    expect(hiddenTerminalWindowIndex("bad")).toBe(1000)
  })
})
