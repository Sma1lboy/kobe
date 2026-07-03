/**
 * Edge/recovery branches of layout-actions.ts that the happy paths in
 * layout-actions-dispatch.test.ts don't reach: vanished hidden panes,
 * un-restorable layouts (no engine pane), close-tab cleanup of hidden
 * panes + the empty helper-session sweep, zen without keepTasks, and
 * zen's nothing-to-hide message. Same in-memory `@/tmux/client` fake as
 * the sibling file.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"

type FakeRow = { paneId: string; role: string; active: boolean }

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(["kobe-t1"]),
  rows: [] as FakeRow[],
  hiddenSessionRoles: [] as string[],
  windowIds: ["@1"],
  windowOptions: {} as Record<string, Record<string, string>>,
  sessionOptions: {} as Record<string, string>,
  existingPaneIds: new Set<string>(),
  splitFails: false,
  joinFails: false,
  breakFails: false,
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
    readLayoutGeometry: async () => ({ tasksWidth: 32, rightColumnWidthPct: 30, opsHeightPct: 50 }),
    getSessionOption: async (_s: string, option: string) => state.sessionOptions[option] ?? "",
    getSessionOptions: async (_s: string, options: readonly string[]) =>
      Object.fromEntries(options.map((o) => [o, state.sessionOptions[o]])),
    setSessionOption: async (_s: string, option: string, value: string) => {
      state.sessionOptions[option] = value
    },
    runTmux: async (args: string[]) => {
      state.calls.push(args)
      if (args[0] === "join-pane" && state.joinFails) return 1
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
        return { code: 0, stdout: state.hiddenSessionRoles.join("\n") }
      }
      if (cmd === "list-windows" && format === "#{window_active}\t#{window_id}") {
        return { code: 0, stdout: "1\t@1" }
      }
      if (cmd === "list-windows" && format === "#{window_index}") return { code: 0, stdout: "" }
      if (cmd === "list-windows" && format === "#{window_id}") {
        return { code: 0, stdout: state.windowIds.join("\n") }
      }
      if (cmd === "show-options" && args.includes("-wqv")) {
        const windowId = args[args.indexOf("-t") + 1]
        const option = args[args.length - 1]
        return { code: 0, stdout: state.windowOptions[windowId ?? ""]?.[option ?? ""] ?? "" }
      }
      if (cmd === "display-message" && args.includes("-p") && args[args.length - 1] === "#{pane_id}") {
        const target = args[args.indexOf("-t") + 1] ?? ""
        return { code: 0, stdout: state.existingPaneIds.has(target) ? target : "" }
      }
      if (cmd === "split-window") return state.splitFails ? { code: 1, stdout: "" } : { code: 0, stdout: "%99" }
      if (cmd === "break-pane") return state.breakFails ? { code: 1, stdout: "" } : { code: 0, stdout: "%99" }
      return { code: 0, stdout: "" }
    },
  }
})

const { runLayoutAction } = await import("../../src/tui/panes/terminal/layout-actions")

function resetState(): void {
  state.existingSessions = new Set(["kobe-t1"])
  state.rows = []
  state.hiddenSessionRoles = []
  state.windowIds = ["@1"]
  state.windowOptions = {}
  state.sessionOptions = {}
  state.existingPaneIds = new Set()
  state.splitFails = false
  state.joinFails = false
  state.breakFails = false
  state.calls = []
  state.capturingCalls = []
}

function callsWith(cmd: string): string[][] {
  return state.calls.filter((c) => c[0] === cmd)
}

function displayed(): string {
  return callsWith("display-message")
    .map((c) => c.join(" "))
    .join("\n")
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

describe("un-restorable layouts", () => {
  test("tasks-restore in a window with no panes at all reports the failure", async () => {
    state.rows = []
    await runLayoutAction("kobe-t1", "tasks-restore")
    expect(displayed()).toContain("cannot restore Tasks pane")
  })

  test("ops-toggle without an engine pane reports it cannot restore the file pane", async () => {
    state.rows = [{ paneId: "%9", role: "shell", active: true }]
    await runLayoutAction("kobe-t1", "ops-toggle")
    expect(displayed()).toContain("cannot restore file pane")
    expect(state.capturingCalls.some((c) => c[0] === "split-window")).toBe(false)
  })

  test("terminal-toggle with no ops and no engine reports it cannot restore", async () => {
    state.rows = [{ paneId: "%9", role: "tasks", active: true }]
    await runLayoutAction("kobe-t1", "terminal-toggle")
    expect(displayed()).toContain("cannot restore terminal pane")
  })

  test("a failed hide (break-pane error) is surfaced, not silently swallowed", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "tasks", active: false },
    ]
    state.breakFails = true
    await runLayoutAction("kobe-t1", "tasks-toggle")
    expect(displayed()).toContain("could not hide Tasks pane")
  })

  test("a failed join on Tasks restore is surfaced and leaves the hidden record intact", async () => {
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    state.windowOptions["@1"] = { "@kobe_hidden_tasks_pane": "%h1" }
    state.existingPaneIds = new Set(["%h1"])
    state.joinFails = true
    await runLayoutAction("kobe-t1", "tasks-toggle")
    expect(displayed()).toContain("could not restore Tasks pane")
    // the window option is NOT cleared on failure
    expect(callsWith("set-window-option").some((c) => c.includes("-u"))).toBe(false)
  })

  test("a vanished hidden Tasks pane falls back to selecting a visible Tasks pane", async () => {
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "tasks", active: false },
    ]
    state.windowOptions["@1"] = { "@kobe_hidden_tasks_pane": "%gone" }
    state.existingPaneIds = new Set()
    await runLayoutAction("kobe-t1", "tasks-toggle")
    expect(callsWith("select-pane")).toEqual([["select-pane", "-t", "%2"]])
  })
})

describe("chat-tab-close hidden-pane cleanup", () => {
  test("kills this window's hidden panes and sweeps an empty helper session", async () => {
    state.windowIds = ["@1", "@2"]
    state.windowOptions["@1"] = {
      "@kobe_hidden_shell_pane": "%h1",
      "@kobe_hidden_tasks_pane": "%h2",
    }
    state.existingPaneIds = new Set(["%h1", "%h2"])
    state.existingSessions.add("kobe-hidden-kobe-t1")
    state.hiddenSessionRoles = ["", ""] // nothing kobe-owned left after the kills
    await runLayoutAction("kobe-t1", "chat-tab-close")
    expect(callsWith("kill-pane")).toEqual(
      expect.arrayContaining([
        ["kill-pane", "-t", "%h1"],
        ["kill-pane", "-t", "%h2"],
      ]),
    )
    expect(callsWith("kill-session")).toEqual([["kill-session", "-t", "=kobe-hidden-kobe-t1"]])
    expect(callsWith("kill-window")).toEqual([["kill-window", "-t", "@1"]])
  })

  test("keeps the helper session alive while it still hosts another window's hidden pane", async () => {
    state.windowIds = ["@1", "@2"]
    state.windowOptions["@1"] = { "@kobe_hidden_shell_pane": "%h1" }
    state.existingPaneIds = new Set(["%h1"])
    state.existingSessions.add("kobe-hidden-kobe-t1")
    state.hiddenSessionRoles = ["shell"] // some other window's shell still parked
    await runLayoutAction("kobe-t1", "chat-tab-close")
    expect(callsWith("kill-session")).toEqual([])
  })
})

describe("zen edge branches", () => {
  test("zen without keepTasks hides the Tasks rail too and records all three roles", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(false)
    vi.mocked(zen.zenKeepsTasks).mockReturnValue(false)
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
      { paneId: "%3", role: "shell", active: false },
      { paneId: "%4", role: "tasks", active: false },
    ]
    await runLayoutAction("kobe-t1", "zen-toggle")
    const recorded = callsWith("set-window-option").find((c) => c.includes("@kobe_zen_panes"))
    expect(recorded?.[recorded.length - 1]).toBe("ops,shell,tasks")
  })

  test("zen on an already-bare window reports nothing to hide and records nothing", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(false)
    vi.mocked(zen.zenKeepsTasks).mockReturnValue(true)
    state.rows = [{ paneId: "%1", role: "claude", active: true }]
    await runLayoutAction("kobe-t1", "zen-toggle")
    expect(displayed()).toContain("already focused")
    expect(callsWith("set-window-option").some((c) => c.includes("@kobe_zen_panes"))).toBe(false)
  })

  test("exiting zen restores the hidden shell recorded under SHELL_PANE_ROLE", async () => {
    const zen = await import("../../src/state/zen")
    vi.mocked(zen.zenIsActive).mockReturnValue(true)
    state.windowOptions["@1"] = {
      "@kobe_zen_panes": "shell",
      "@kobe_hidden_shell_pane": "%h1",
    }
    state.existingPaneIds = new Set(["%h1"])
    state.rows = [
      { paneId: "%1", role: "claude", active: true },
      { paneId: "%2", role: "ops", active: false },
    ]
    await runLayoutAction("kobe-t1", "zen-toggle")
    expect(callsWith("join-pane")[0]).toEqual(expect.arrayContaining(["-s", "%h1", "-t", "%2"]))
  })
})
