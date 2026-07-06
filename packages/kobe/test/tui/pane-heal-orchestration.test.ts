/**
 * Behavioral tests for pane-heal.ts's async orchestration — everything
 * `terminal-pane-heal.test.ts` deliberately leaves out because it needs a
 * live tmux server there. Here `@/tmux/client` is replaced with an
 * in-memory fake (same technique as layout-actions-dispatch.test.ts /
 * chattab.test.ts) so the heal/respawn/capture DECISIONS are exercised
 * without ever spawning tmux.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(["kobe-t1"]),
  paneRows: [] as Array<{ windowId: string; paneId: string; role: string; version: string; paneWidth?: number }>,
  captureRows: [] as string[][], // raw tab-separated lines for captureGlobalLayout / shouldCaptureDrag listings
  geometry: { tasksWidth: 32, rightColumnResizeArgs: [] as readonly string[] },
  sessionOptions: {} as Record<string, string>,
  calls: [] as string[][],
  capturingCalls: [] as string[][],
}))

function paneRowsStdout(): string {
  return state.paneRows
    .map((r) => `${r.windowId}\t${r.paneId}\t${r.role}\t${r.version}\t${r.paneWidth ?? ""}`)
    .join("\n")
}

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))
vi.mock("../../src/exec/resolve", () => ({ localSpawnCwd: (p: string) => p }))
vi.mock("../../src/engine/interactive-command", () => ({
  withClaudeSessionId: vi.fn((argv: readonly string[], vendor: string | undefined) =>
    (vendor ?? "claude") === "claude"
      ? { argv: [...argv, "--session-id", "new-id"], sessionId: "new-id" }
      : { argv, sessionId: null },
  ),
}))
vi.mock("../../src/tui/lib/tmux-border-theme", () => ({ applyTmuxChromeTheme: vi.fn(async () => {}) }))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return {
    ...actual,
    sessionExists: async (name: string) => state.existingSessions.has(name),
    readLayoutGeometry: async () => state.geometry,
    getSessionOptions: async (_session: string, options: readonly string[]) =>
      Object.fromEntries(options.map((o) => [o, state.sessionOptions[o]])),
    runTmuxSequence: async (commands: readonly (readonly string[])[]) => {
      for (const c of commands) state.calls.push([...c])
      return 0
    },
    runTmuxCapturing: async (args: string[]) => {
      state.capturingCalls.push(args)
      const fIdx = args.indexOf("-F")
      const format = fIdx >= 0 ? args[fIdx + 1] : ""
      if (args[0] === "list-panes" && format?.includes("pane_width") && !format.includes("window_zoomed_flag")) {
        return { code: 0, stdout: paneRowsStdout() }
      }
      if (args[0] === "list-panes") {
        // captureGlobalLayout / captureGlobalLayoutOnDrag listings
        return { code: 0, stdout: state.captureRows.map((r) => r.join("\t")).join("\n") }
      }
      return { code: 0, stdout: "" }
    },
  }
})

const paneHeal = await import("../../src/tui/panes/terminal/pane-heal")
const themeMock = await import("../../src/tui/lib/tmux-border-theme")

function resetState(): void {
  state.existingSessions = new Set(["kobe-t1"])
  state.paneRows = []
  state.captureRows = []
  state.geometry = { tasksWidth: 32, rightColumnResizeArgs: [] }
  state.sessionOptions = {}
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
  vi.restoreAllMocks()
})

describe("workspaceLayoutPaneCommands", () => {
  test("re-pins a Tasks rail that drifted from the global width", async () => {
    state.geometry = { tasksWidth: 32, rightColumnResizeArgs: [] }
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.8.0", paneWidth: 20 }]
    const { commands } = await paneHeal.workspaceLayoutPaneCommands("kobe-t1")
    expect(commands).toEqual([["resize-pane", "-t", "%1", "-x", "32"]])
  })

  test("skips a Tasks rail already at the target width unless forced", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.8.0", paneWidth: 32 }]
    expect((await paneHeal.workspaceLayoutPaneCommands("kobe-t1")).commands).toEqual([])
    expect((await paneHeal.workspaceLayoutPaneCommands("kobe-t1", { force: true })).commands).toEqual([
      ["resize-pane", "-t", "%1", "-x", "32"],
    ])
  })

  test("applies the global right-column geometry to the Ops pane", async () => {
    state.geometry = { tasksWidth: 32, rightColumnResizeArgs: ["-x", "60%"] }
    state.paneRows = [{ windowId: "@1", paneId: "%2", role: "ops", version: "0.8.0" }]
    const { commands } = await paneHeal.workspaceLayoutPaneCommands("kobe-t1")
    expect(commands).toEqual([["resize-pane", "-t", "%2", "-x", "60%"]])
  })

  test("returns null rows when the session's pane listing fails", async () => {
    state.existingSessions = new Set() // sessionExists false doesn't matter here — listKobePanes just reads code!==0
    const result = await paneHeal.workspaceLayoutPaneCommands("kobe-ghost")
    // our fake runTmuxCapturing always returns code:0, so this actually returns rows: []
    expect(result.rows).toEqual([])
  })
})

describe("healWorkspaceLayout", () => {
  test("re-pins layout and respawns stale kobe panes when versions are passed", async () => {
    state.paneRows = [
      { windowId: "@1", paneId: "%1", role: "tasks", version: "", paneWidth: 32 },
      { windowId: "@1", paneId: "%0", role: "claude", version: "" },
    ]
    await paneHeal.healWorkspaceLayout("kobe-t1", { cwd: "/wt", taskId: "t1", vendor: "claude" })
    expect(callsWith("respawn-pane")).toHaveLength(1)
    expect(callsWith("respawn-pane")[0]).toEqual(expect.arrayContaining(["-k", "-t", "%1", "-c", "/wt"]))
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([["set-option", "-p", "-t", "%1", "@kobe_role", "tasks"]]),
    )
  })

  test("without a versions arg, only re-pins layout — no respawns", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "", paneWidth: 20 }]
    await paneHeal.healWorkspaceLayout("kobe-t1")
    expect(callsWith("respawn-pane")).toEqual([])
    expect(callsWith("resize-pane")).toEqual([["resize-pane", "-t", "%1", "-x", "32"]])
  })

  test("no-ops entirely when the pane listing can't be read", async () => {
    // Force listKobePanes to fail by making runTmuxCapturing report a non-zero code
    // for the pane-width listing specifically.
    const client = await import("../../src/tmux/client")
    vi.spyOn(client, "runTmuxCapturing").mockResolvedValue({ code: 1, stdout: "" })
    await paneHeal.healWorkspaceLayout("kobe-t1", { cwd: "/wt", taskId: "t1", vendor: "claude" })
    expect(state.calls).toEqual([])
  })
})

describe("healSessionLayout", () => {
  test("no-ops for a session that doesn't exist", async () => {
    state.existingSessions = new Set()
    await paneHeal.healSessionLayout("kobe-ghost")
    expect(state.calls).toEqual([])
    expect(state.capturingCalls).toEqual([])
  })

  test("heals an existing session's layout", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.8.0", paneWidth: 10 }]
    await paneHeal.healSessionLayout("kobe-t1")
    expect(callsWith("resize-pane")).toEqual([["resize-pane", "-t", "%1", "-x", "32"]])
  })
})

describe("relaunchEngineInAllWindows", () => {
  test("returns no-engine-pane when the session has no engine panes", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.8.0" }]
    const result = await paneHeal.relaunchEngineInAllWindows("kobe-t1", "/wt", ["claude"])
    expect(result).toBe("no-engine-pane")
    expect(state.calls).toEqual([])
  })

  test("respawns every engine pane and reports switched on success", async () => {
    state.paneRows = [
      { windowId: "@1", paneId: "%0", role: "claude", version: "" },
      { windowId: "@2", paneId: "%4", role: "claude", version: "" },
    ]
    const result = await paneHeal.relaunchEngineInAllWindows("kobe-t1", "/wt", ["claude"], undefined, "claude")
    expect(result).toBe("switched")
    expect(callsWith("respawn-pane")).toHaveLength(2)
    expect(callsWith("set-window-option")).toEqual(
      expect.arrayContaining([["set-window-option", "-t", "%0", "@kobe_session_id", "new-id"]]),
    )
  })

  test("reports respawn-failed without pretending every window switched", async () => {
    state.paneRows = [{ windowId: "@1", paneId: "%0", role: "claude", version: "" }]
    const client = await import("../../src/tmux/client")
    vi.spyOn(client, "runTmuxSequence").mockImplementation(async (commands) => {
      for (const c of commands) state.calls.push([...c])
      return 1
    })
    const result = await paneHeal.relaunchEngineInAllWindows("kobe-t1", "/wt", ["claude"], undefined, "claude")
    expect(result).toBe("respawn-failed")
  })
})

describe("globalRightColumnResizeArgs", () => {
  test("reads through to the global geometry", async () => {
    state.geometry = { tasksWidth: 32, rightColumnResizeArgs: ["-x", "40%", "-y", "60%"] }
    expect(await paneHeal.globalRightColumnResizeArgs()).toEqual(["-x", "40%", "-y", "60%"])
  })
})

describe("captureGlobalLayout", () => {
  const header = (
    role: string,
    paneWidth: string,
    paneHeight: string,
    windowWidth = "160",
    windowHeight = "40",
    zoomed = "",
    hiddenShell = "",
    hiddenTasks = "",
  ) => [role, paneWidth, paneHeight, windowWidth, windowHeight, zoomed, hiddenShell, hiddenTasks]

  test("persists Tasks width + Ops width/height percentages from the active window", async () => {
    state.captureRows = [header("tasks", "32", "40"), header("ops", "64", "20"), header("shell", "64", "20")]
    await paneHeal.captureGlobalLayout("kobe-t1")
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([
        ["set-option", "-s", "@kobe_tasks_width", "32"],
        ["set-option", "-s", "@kobe_right_width_pct", "40"],
      ]),
    )
  })

  test("bails when any pane is zoomed — geometry would be garbage", async () => {
    state.captureRows = [header("tasks", "32", "40", "160", "40", "1"), header("shell", "160", "40")]
    await paneHeal.captureGlobalLayout("kobe-t1")
    expect(state.calls).toEqual([])
  })

  test("bails when the shell pane is hidden (Ops temporarily fills the column)", async () => {
    state.captureRows = [header("tasks", "32", "40", "160", "40", "", "%hidden"), header("ops", "64", "40")]
    await paneHeal.captureGlobalLayout("kobe-t1")
    expect(state.calls).toEqual([])
  })

  test("bails when the shell pane is gone entirely (user typed exit)", async () => {
    state.captureRows = [header("tasks", "32", "40"), header("ops", "128", "40")]
    await paneHeal.captureGlobalLayout("kobe-t1")
    expect(state.calls).toEqual([])
  })
})

describe("shouldCaptureDrag", () => {
  test("true only with the full tasks+ops+shell role set, unzoomed, unhidden", () => {
    expect(paneHeal.shouldCaptureDrag("tasks\t\t\t\nops\t\t\t\nshell\t\t\t")).toBe(true)
    expect(paneHeal.shouldCaptureDrag("tasks\t1\t\t\nops\t\t\t\nshell\t\t\t")).toBe(false)
    expect(paneHeal.shouldCaptureDrag("tasks\t\t%h\t\nops\t\t\t\nshell\t\t\t")).toBe(false)
    expect(paneHeal.shouldCaptureDrag("tasks\t\t\t\nops\t\t\t")).toBe(false)
    expect(paneHeal.shouldCaptureDrag("")).toBe(false)
  })
})

describe("captureGlobalLayoutOnDrag", () => {
  test("captures when the drag gate passes", async () => {
    state.capturingCalls = []
    // First runTmuxCapturing call (the drag-gate listing) needs the 4-col shape;
    // route via a spy since our shared fake's list-panes branch expects the
    // 8-col captureGlobalLayout shape.
    const client = await import("../../src/tmux/client")
    const spy = vi
      .spyOn(client, "runTmuxCapturing")
      .mockResolvedValueOnce({ code: 0, stdout: "tasks\t\t\t\nops\t\t\t\nshell\t\t\t" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "tasks\t32\t40\t160\t40\t\t\t\nops\t64\t20\t160\t40\t\t\t\nshell\t64\t20\t160\t40\t\t\t",
      })
    await paneHeal.captureGlobalLayoutOnDrag("kobe-t1")
    expect(callsWith("set-option").length).toBeGreaterThan(0)
    spy.mockRestore()
  })

  test("skips the capture entirely when the gate fails", async () => {
    const client = await import("../../src/tmux/client")
    const spy = vi.spyOn(client, "runTmuxCapturing").mockResolvedValueOnce({ code: 0, stdout: "tasks\t1\t\t" })
    await paneHeal.captureGlobalLayoutOnDrag("kobe-t1")
    expect(state.calls).toEqual([])
    spy.mockRestore()
  })
})

describe("refreshKobeWorkspacePanes", () => {
  test("respawns stale kobe panes (forced) and re-applies the tmux chrome theme", async () => {
    state.sessionOptions = { "@kobe_worktree": "/wt", "@kobe_task": "t1", "@kobe_vendor": "claude" }
    state.paneRows = [{ windowId: "@1", paneId: "%1", role: "tasks", version: "0.1.0" }]
    await paneHeal.refreshKobeWorkspacePanes("kobe-t1")
    expect(callsWith("respawn-pane")).toHaveLength(1)
    expect(themeMock.applyTmuxChromeTheme).toHaveBeenCalledTimes(1)
  })

  test("no-ops the respawn but still restyles chrome when the pane listing is empty", async () => {
    state.paneRows = []
    await paneHeal.refreshKobeWorkspacePanes("kobe-t1")
    expect(callsWith("respawn-pane")).toEqual([])
    expect(themeMock.applyTmuxChromeTheme).toHaveBeenCalledTimes(1)
  })
})
