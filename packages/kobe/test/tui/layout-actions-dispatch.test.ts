/**
 * Behavioral tests for the tmux-driving decisions in layout-actions.ts —
 * `runLayoutAction`'s per-action dispatch, zen mode enter/exit, and
 * `engineTabExit`. The pure builders (parseLayoutPaneRows, planWorkspaceSplit,
 * resolveShellPane, expandedTerminalHeightPercent) are covered separately in
 * layout-actions.test.ts; this file exercises the async orchestration that
 * decides WHICH tmux commands get issued for a given pane layout, by
 * replacing `@/tmux/client` with an in-memory fake (same technique as
 * perf-budgets.test.ts) so no real tmux process is ever spawned.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

type FakeRow = { paneId: string; role: string; active: boolean }

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(["kobe-t1"]),
  rows: [] as FakeRow[],
  windowIds: ["@1"],
  activeWindowIdValue: "@1",
  windowOptions: {} as Record<string, Record<string, string>>,
  sessionOptions: {} as Record<string, string>,
  existingPaneIds: new Set<string>(),
  newPaneId: "%99",
  geometry: { tasksWidth: 32, rightColumnWidthPct: 30, opsHeightPct: 50 },
  calls: [] as string[][],
  capturingCalls: [] as string[][],
}))

function rowsStdout(rows: readonly FakeRow[]): string {
  return rows.map((r) => `${r.paneId}\t${r.role}\t${r.active ? 1 : 0}\t80\t20\t160\t40`).join("\n")
}

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))
vi.mock("../../src/exec/resolve", () => ({
  localSpawnCwd: (p: string) => p,
  execHostForRepo: () => ({ isRemote: false }),
}))
vi.mock("../../src/state/zen", () => ({
  zenIsActive: vi.fn(() => false),
  setZenActive: vi.fn(),
  zenKeepsTasks: vi.fn(() => true),
}))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return {
    ...actual,
    sessionExists: async (name: string) => state.existingSessions.has(name),
    readLayoutGeometry: async () => state.geometry,
    getSessionOption: async (_session: string, option: string) => state.sessionOptions[option] ?? "",
    getSessionOptions: async (_session: string, options: readonly string[]) =>
      Object.fromEntries(options.map((o) => [o, state.sessionOptions[o]])),
    setSessionOption: async (_session: string, option: string, value: string) => {
      state.calls.push(["setSessionOption", option, value])
      state.sessionOptions[option] = value
    },
    runTmux: async (args: string[]) => {
      state.calls.push(args)
      return 0
    },
    runTmuxSequence: async (commands: readonly (readonly string[])[]) => {
      for (const c of commands) state.calls.push([...c])
      return 0
    },
    runTmuxCapturing: async (args: string[]) => {
      state.capturingCalls.push(args)
      const cmd = args[0]
      const fIdx = args.indexOf("-F")
      const format = fIdx >= 0 ? args[fIdx + 1] : ""
      if (cmd === "list-panes" && format?.includes("pane_active")) {
        return { code: 0, stdout: rowsStdout(state.rows) }
      }
      if (cmd === "list-panes" && format === "#{@kobe_role}") {
        return { code: 0, stdout: state.rows.map((r) => r.role).join("\n") }
      }
      if (cmd === "list-windows" && format === "#{window_active}\t#{window_id}") {
        return { code: 0, stdout: `1\t${state.activeWindowIdValue}` }
      }
      if (cmd === "list-windows" && format === "#{window_index}") {
        return { code: 0, stdout: "" }
      }
      if (cmd === "list-windows" && format === "#{window_id}") {
        return { code: 0, stdout: state.windowIds.join("\n") }
      }
      if (cmd === "show-options" && args.includes("-wqv")) {
        const windowId = args[args.indexOf("-t") + 1]
        const option = args[args.length - 1]
        return { code: 0, stdout: state.windowOptions[windowId]?.[option] ?? "" }
      }
      if (cmd === "display-message" && args.includes("-p") && args[args.length - 1] === "#{pane_id}") {
        const target = args[args.indexOf("-t") + 1]
        return { code: 0, stdout: state.existingPaneIds.has(target) ? target : "" }
      }
      if (cmd === "split-window" || cmd === "break-pane" || cmd === "join-pane") {
        return { code: 0, stdout: state.newPaneId }
      }
      return { code: 0, stdout: "" }
    },
  }
})

vi.mock("../../src/tui/panes/terminal/chattab", () => ({
  newChatTab: vi.fn(async (session: string) => {
    state.activeWindowIdValue = "@2"
    state.windowIds = [...state.windowIds, "@2"]
  }),
}))

const { runLayoutAction, syncSessionZen, applyZenToNewWindow, engineTabExit } = await import(
  "../../src/tui/panes/terminal/layout-actions"
)
const chattabMock = await import("../../src/tui/panes/terminal/chattab")

function resetState(): void {
  state.existingSessions = new Set(["kobe-t1"])
  state.rows = []
  state.windowIds = ["@1"]
  state.activeWindowIdValue = "@1"
  state.windowOptions = {}
  state.sessionOptions = {}
  state.existingPaneIds = new Set()
  state.newPaneId = "%99"
  state.geometry = { tasksWidth: 32, rightColumnWidthPct: 30, opsHeightPct: 50 }
  state.calls = []
  state.capturingCalls = []
}

function callsWith(cmd: string): string[][] {
  return state.calls.filter((c) => c[0] === cmd)
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("runLayoutAction — session guard", () => {
  test("no-ops when the session doesn't exist", async () => {
    state.existingSessions = new Set()
    await runLayoutAction("kobe-ghost", "workspace-split")
    expect(state.calls).toEqual([])
    expect(state.capturingCalls).toEqual([])
  })
})

describe("workspace-split / workspace-close / workspace-reset", () => {
  test("splits the engine pane horizontally when there is room", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "workspace-split")
    const splits = state.capturingCalls.filter((c) => c[0] === "split-window")
    expect(splits).toHaveLength(1)
    expect(splits[0]).toEqual(expect.arrayContaining(["-h", "-t", "%1"]))
    // the new pane is tagged workspace_aux and selected
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([["set-option", "-p", "-t", "%99", "@kobe_role", "workspace_aux"]]),
    )
    expect(callsWith("select-pane")).toEqual(expect.arrayContaining([["select-pane", "-t", "%99"]]))
  })

  test("refuses a 5th middle pane and displays the limit", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "workspace_aux", active: false },
      { paneId: "%3", role: "workspace_aux", active: false },
      { paneId: "%4", role: "workspace_aux", active: false },
    ]
    await runLayoutAction("kobe-t1", "workspace-split")
    expect(state.capturingCalls.some((c) => c[0] === "split-window")).toBe(false)
    expect(callsWith("display-message").some((c) => c.join(" ").includes("workspace split limit"))).toBe(true)
  })

  test("workspace-close kills the active aux pane", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: false },
      { paneId: "%2", role: "workspace_aux", active: true },
    ]
    await runLayoutAction("kobe-t1", "workspace-close")
    expect(callsWith("kill-pane")).toEqual([["kill-pane", "-t", "%2"]])
  })

  test("workspace-close with nothing to close displays a message, no kill", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "workspace-close")
    expect(callsWith("kill-pane")).toEqual([])
    expect(callsWith("display-message").some((c) => c.join(" ").includes("no workspace split"))).toBe(true)
  })

  test("workspace-reset kills every aux pane", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "workspace_aux", active: false },
      { paneId: "%3", role: "workspace_aux", active: false },
    ]
    await runLayoutAction("kobe-t1", "workspace-reset")
    expect(callsWith("kill-pane")).toEqual([
      ["kill-pane", "-t", "%2"],
      ["kill-pane", "-t", "%3"],
    ])
  })
})

describe("tasks-toggle / tasks-restore", () => {
  test("with no Tasks pane and nothing hidden, creates one off the engine pane", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "tasks-toggle")
    const split = state.capturingCalls.find((c) => c[0] === "split-window")
    expect(split).toEqual(expect.arrayContaining(["-h", "-b", "-t", "%1", "-l", "32"]))
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([["set-option", "-p", "-t", "%99", "@kobe_role", "tasks"]]),
    )
  })

  test("with a visible Tasks pane, hides it into the helper session", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "tasks", active: false },
    ]
    // hideTasksPane first ensures the hidden helper session exists
    state.existingSessions = new Set(["kobe-t1", "kobe-hidden-kobe-t1"])
    await runLayoutAction("kobe-t1", "tasks-toggle")
    expect(state.capturingCalls.some((c) => c[0] === "break-pane" && c.includes("%2"))).toBe(true)
    expect(
      callsWith("set-option").some((c) => c[1] === "-t" && c[2] === "@1" && c[3] === "@kobe_hidden_tasks_pane"),
    ).toBe(false)
  })

  test("restores a hidden Tasks pane by joining it back", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    state.windowOptions["@1"] = { "@kobe_hidden_tasks_pane": "%hidden1" }
    state.existingPaneIds = new Set(["%hidden1"])
    await runLayoutAction("kobe-t1", "tasks-toggle")
    const join = callsWith("join-pane")[0]
    expect(join).toBeDefined()
    expect(join).toEqual(expect.arrayContaining(["-s", "%hidden1", "-t", "%1"]))
  })

  test("tasks-restore selects an already-visible Tasks pane without rebuilding", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "tasks", active: false },
    ]
    await runLayoutAction("kobe-t1", "tasks-restore")
    expect(callsWith("select-pane")).toEqual([["select-pane", "-t", "%2"]])
    expect(state.capturingCalls.some((c) => c[0] === "split-window")).toBe(false)
  })
})

describe("ops-toggle / terminal-toggle", () => {
  test("ops-toggle creates the file pane when absent, splitting off the shell", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "shell", active: false },
    ]
    await runLayoutAction("kobe-t1", "ops-toggle")
    const split = state.capturingCalls.find((c) => c[0] === "split-window")
    expect(split).toEqual(expect.arrayContaining(["-v", "-b", "-t", "%2"]))
  })

  test("ops-toggle kills an existing Ops pane", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
    ]
    await runLayoutAction("kobe-t1", "ops-toggle")
    expect(callsWith("kill-pane")).toEqual([["kill-pane", "-t", "%2"]])
  })

  test("terminal-toggle hides the shell pane into the helper session", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "shell", active: false },
    ]
    await runLayoutAction("kobe-t1", "terminal-toggle")
    expect(state.capturingCalls.some((c) => c[0] === "break-pane")).toBe(true)
    expect(callsWith("set-window-option")).toEqual(
      expect.arrayContaining([["set-window-option", "-t", "@1", "@kobe_hidden_shell_pane", "%99"]]),
    )
  })

  test("terminal-toggle restores a hidden shell pane by joining it below the Ops pane", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
    ]
    state.windowOptions["@1"] = { "@kobe_hidden_shell_pane": "%h1" }
    state.existingPaneIds = new Set(["%h1"])
    await runLayoutAction("kobe-t1", "terminal-toggle")
    const join = callsWith("join-pane")[0]
    expect(join).toEqual(expect.arrayContaining(["-v", "-s", "%h1", "-t", "%2"]))
    // the restored pane is re-tagged shell and the window option cleared
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([["set-option", "-p", "-t", "%h1", "@kobe_role", "shell"]]),
    )
    expect(callsWith("set-window-option")).toEqual(
      expect.arrayContaining([["set-window-option", "-u", "-t", "@1", "@kobe_hidden_shell_pane"]]),
    )
  })

  test("terminal-toggle with a vanished hidden pane creates a fresh one instead", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
    ]
    state.windowOptions["@1"] = { "@kobe_hidden_shell_pane": "%gone" }
    state.existingPaneIds = new Set() // hidden pane no longer exists
    await runLayoutAction("kobe-t1", "terminal-toggle")
    expect(callsWith("join-pane")).toEqual([])
    const split = state.capturingCalls.find((c) => c[0] === "split-window")
    expect(split).toEqual(expect.arrayContaining(["-v", "-t", "%2"]))
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([["set-option", "-p", "-t", "%99", "@kobe_role", "shell"]]),
    )
  })

  test("terminal-toggle creates a right-column split when only the engine pane exists", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "terminal-toggle")
    const split = state.capturingCalls.find((c) => c[0] === "split-window")
    expect(split).toEqual(expect.arrayContaining(["-h", "-t", "%1"]))
  })
})

describe("chat-tab-close", () => {
  test("refuses to close the only ChatTab", async () => {
    state.windowIds = ["@1"]
    await runLayoutAction("kobe-t1", "chat-tab-close")
    expect(callsWith("kill-window")).toEqual([])
    expect(callsWith("display-message").some((c) => c.join(" ").includes("only ChatTab"))).toBe(true)
  })

  test("closes the window when a sibling tab exists", async () => {
    state.windowIds = ["@1", "@2"]
    await runLayoutAction("kobe-t1", "chat-tab-close")
    expect(callsWith("kill-window")).toEqual([["kill-window", "-t", "@1"]])
  })
})

describe("zen-toggle", () => {
  test("entering zen hides ops/shell across every engine window and flips the session option", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(false)
    state.windowIds = ["@1"]
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
      { paneId: "%3", role: "shell", active: false },
    ]
    await runLayoutAction("kobe-t1", "zen-toggle")
    expect(zen.setZenActive).toHaveBeenCalledWith(true)
    expect(callsWith("kill-pane")).toEqual(expect.arrayContaining([["kill-pane", "-t", "%2"]]))
    expect(state.sessionOptions["@kobe_zen"]).toBe("1")
    expect(
      state.windowOptions["@1"]?.["@kobe_zen_panes"] ?? state.calls.find((c) => c[3] === "@kobe_zen_panes"),
    ).toBeTruthy()
  })

  test("exiting zen restores what it recorded as hidden", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(true)
    state.windowIds = ["@1"]
    state.windowOptions["@1"] = { "@kobe_zen_panes": "ops" }
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "zen-toggle")
    expect(zen.setZenActive).toHaveBeenCalledWith(false)
    // ops wasn't present, so exitZenMode's ops branch re-adds it via toggleOpsPane
    expect(state.capturingCalls.some((c) => c[0] === "split-window")).toBe(true)
  })
})

describe("syncSessionZen", () => {
  test("no-ops for a session that doesn't exist", async () => {
    state.existingSessions = new Set()
    await syncSessionZen("kobe-ghost")
    expect(state.calls).toEqual([])
  })

  test("no-ops when the session already matches the global intent", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(false)
    state.sessionOptions["@kobe_zen"] = ""
    await syncSessionZen("kobe-t1")
    expect(state.calls).toEqual([])
  })

  test("enters zen when the global intent is on but this session hasn't caught up", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(true)
    state.windowIds = ["@1"]
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "shell", active: false },
    ]
    await syncSessionZen("kobe-t1")
    expect(state.sessionOptions["@kobe_zen"]).toBe("1")
  })
})

describe("applyZenToNewWindow", () => {
  test("collapses a freshly created window when the global zen intent is on", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(true)
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "shell", active: false },
    ]
    await applyZenToNewWindow("kobe-t1", "@1")
    expect(state.sessionOptions["@kobe_zen"]).toBe("1")
    expect(callsWith("kill-pane")).toEqual([])
    expect(state.capturingCalls.some((c) => c[0] === "break-pane")).toBe(true)
  })

  test("leaves a non-engine window alone", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(true)
    state.rows = [{ paneId: "%1", role: "", active: true }]
    await applyZenToNewWindow("kobe-t1", "@1")
    expect(state.capturingCalls.some((c) => c[0] === "break-pane")).toBe(false)
  })

  test("does nothing when zen is off everywhere", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(false)
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await applyZenToNewWindow("kobe-t1", "@1")
    expect(state.calls).toEqual([])
  })
})

describe("engineTabExit", () => {
  test("no-ops when the session is already gone", async () => {
    state.existingSessions = new Set()
    await engineTabExit("kobe-ghost")
    expect(state.calls).toEqual([])
  })

  test("closes just the gutted window when a sibling tab exists", async () => {
    state.windowIds = ["@1", "@2"]
    state.activeWindowIdValue = "@1"
    await engineTabExit("kobe-t1")
    expect(callsWith("kill-window")).toEqual([["kill-window", "-t", "@1"]])
    expect(chattabMock.newChatTab).not.toHaveBeenCalled()
  })

  test("replaces the only tab with a fresh engine tab, then kills the gutted one", async () => {
    state.windowIds = ["@1"]
    state.activeWindowIdValue = "@1"
    await engineTabExit("kobe-t1")
    expect(chattabMock.newChatTab).toHaveBeenCalledWith("kobe-t1")
    // the mock newChatTab flips activeWindowIdValue to @2, so the old @1 gets killed
    expect(callsWith("kill-window")).toEqual([["kill-window", "-t", "@1"]])
  })
})
