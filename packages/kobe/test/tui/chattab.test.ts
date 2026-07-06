/**
 * Behavioral tests for the ChatTab lifecycle (`buildPanesAround`,
 * `newChatTab`, and the dedicated single-page window openers). All tmux
 * commands are captured against an in-memory fake `@/tmux/client` (same
 * technique as `layout-actions-dispatch.test.ts` / `perf-budgets.test.ts`)
 * so no real tmux process is ever spawned; assertions are on WHICH tmux
 * commands got issued with what args, not on internal call counts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const state = vi.hoisted(() => ({
  existingSessions: new Set<string>(["kobe-t1"]),
  sessionOptions: {} as Record<string, string>,
  newPaneId: "%50",
  geometryTasksWidth: 32,
  calls: [] as string[][],
  capturingCalls: [] as string[][],
  newWindowCalls: [] as Array<{ session: string; opts: Record<string, unknown> }>,
}))

vi.mock("../../src/cli/invocation", () => ({ kobeCliInvocation: () => ["kobe"] }))
vi.mock("../../src/exec/resolve", () => ({ localSpawnCwd: (p: string) => p }))
vi.mock("../../src/engine/interactive-command", () => ({
  interactiveEngineCommand: vi.fn((vendor: string | undefined) => [vendor ?? "claude"]),
  withClaudeSessionId: vi.fn((argv: readonly string[], vendor: string | undefined) =>
    (vendor ?? "claude") === "claude"
      ? { argv: [...argv, "--session-id", "fixed-session-id"], sessionId: "fixed-session-id" }
      : { argv, sessionId: null },
  ),
}))
vi.mock("../../src/tui/panes/terminal/layout-actions", () => ({
  applyZenToNewWindow: vi.fn(async () => {}),
}))
vi.mock("../../src/tui/panes/terminal/pane-heal", () => ({
  PANE_VERSION_OPTION: "@kobe_pane_version",
  globalRightColumnResizeArgs: vi.fn(async () => [] as readonly string[]),
}))
vi.mock("../../src/state/repos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/repos")>()
  return { ...actual, resolveMainRepoRoot: vi.fn((p: string) => `${p}-root`) }
})
vi.mock("../../src/state/vendor-prefs", () => ({
  setRepoLastActiveVendor: vi.fn(),
}))

vi.mock("../../src/tmux/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tmux/client")>()
  return {
    ...actual,
    sessionExists: async (name: string) => state.existingSessions.has(name),
    getSessionOptions: async (_session: string, options: readonly string[]) =>
      Object.fromEntries(options.map((o) => [o, state.sessionOptions[o]])),
    setSessionOption: async (_session: string, option: string, value: string) => {
      state.calls.push(["setSessionOption", option, value])
      state.sessionOptions[option] = value
    },
    setWindowOption: async (target: string, option: string, value: string) => {
      state.calls.push(["setWindowOption", target, option, value])
    },
    globalTasksPaneWidth: async () => state.geometryTasksWidth,
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
      if (args[0] === "new-window" || args[0] === "display-message") return { code: 0, stdout: state.newPaneId }
      return { code: 0, stdout: "" }
    },
    runTmuxSequenceCapturing: async (commands: readonly (readonly string[])[]) => {
      for (const c of commands) state.capturingCalls.push([...c])
      // buildPanesAround expects `name=#{pane_id}` lines for tasks/ops/shell.
      return { code: 0, stdout: "tasks=%51\nops=%52\nshell=%53" }
    },
    newWindow: async (session: string, opts: Record<string, unknown>) => {
      state.newWindowCalls.push({ session, opts })
    },
  }
})

vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectOrStartDaemon: vi.fn(async () => ({
    request: vi.fn(async () => ({})),
    close: vi.fn(),
  })),
}))

const chattab = await import("../../src/tui/panes/terminal/chattab")
const daemonProcess = await import("@sma1lboy/kobe-daemon/client/daemon-process")
const stateRepos = await import("../../src/state/repos")
const vendorPrefs = await import("../../src/state/vendor-prefs")

function resetState(): void {
  state.existingSessions = new Set(["kobe-t1"])
  state.sessionOptions = {}
  state.newPaneId = "%50"
  state.geometryTasksWidth = 32
  state.calls = []
  state.capturingCalls = []
  state.newWindowCalls = []
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

describe("chatTabSwitchBindings / chatTabCloseBinding / chatTabRenameBinding", () => {
  test("close binding guards on more than one window", () => {
    expect(chattab.chatTabCloseBinding("C-w")).toEqual([
      "bind-key",
      "-n",
      "C-w",
      "if-shell",
      "-F",
      "#{>:#{session_windows},1}",
      "kill-window",
      "display-message 'Cannot close the only ChatTab'",
    ])
  })

  test("rename binding opens a command-prompt seeded with the window name", () => {
    expect(chattab.chatTabRenameBinding("F2")).toEqual([
      "bind-key",
      "-n",
      "F2",
      "command-prompt",
      "-I",
      "#{window_name}",
      "rename-window -- '%%'",
    ])
  })
})

describe("kobeStatusRight", () => {
  test("renders only the bound segments, compacting C- to ^", () => {
    expect(kobeStatusRightOf({ focusLeft: "C-h", detach: "C-q", newTab: "C-t" })).toBe("^h tasks  ^q detach  ^t tab ")
  })

  test("omits unbound segments entirely", () => {
    expect(kobeStatusRightOf({ focusLeft: "C-h", detach: null, newTab: null })).toBe("^h tasks ")
  })
})

function kobeStatusRightOf(keys: Parameters<typeof chattab.kobeStatusRight>[0]): string {
  return chattab.kobeStatusRight(keys)
}

describe("buildPanesAround", () => {
  test("tags the resolved pane ids with role + version, and resizes ops if geometry says so", async () => {
    await chattab.buildPanesAround("%1", { cwd: "/wt", taskId: "t1", inv: ["kobe"], vendor: "claude" })
    expect(callsWith("set-option")).toEqual(
      expect.arrayContaining([
        ["set-option", "-p", "-t", "%51", "@kobe_role", "tasks"],
        ["set-option", "-p", "-t", "%51", "@kobe_pane_version", expect.any(String)],
        ["set-option", "-p", "-t", "%52", "@kobe_role", "ops"],
        ["set-option", "-p", "-t", "%53", "@kobe_role", "shell"],
      ]),
    )
  })

  test("skips the ops resize-pane when there is no global right-column override", async () => {
    await chattab.buildPanesAround("%1", { cwd: "/wt", inv: ["kobe"] })
    expect(callsWith("resize-pane")).toEqual([])
  })
})

describe("newChatTab", () => {
  test("no-ops when the session doesn't exist", async () => {
    state.existingSessions = new Set()
    await chattab.newChatTab("kobe-ghost")
    expect(state.capturingCalls).toEqual([])
  })

  test("reads the session's tags to relaunch the same engine + worktree", async () => {
    state.sessionOptions = { "@kobe_worktree": "/wt", "@kobe_task": "t1", "@kobe_vendor": "codex" }
    await chattab.newChatTab("kobe-t1")
    const newWindowCall = state.capturingCalls.find((c) => c[0] === "new-window")
    expect(newWindowCall).toEqual(expect.arrayContaining(["-t", "=kobe-t1", "-c", "/wt"]))
  })

  test("an explicit vendor override persists as the session's new default vendor", async () => {
    state.sessionOptions = { "@kobe_worktree": "/wt", "@kobe_task": "t1" }
    await chattab.newChatTab("kobe-t1", "codex")
    expect(state.sessionOptions["@kobe_vendor"]).toBe("codex")
    expect(daemonProcess.connectOrStartDaemon).toHaveBeenCalled()
    // ... and as the PROJECT's last-active engine, keyed on the repo root.
    expect(vendorPrefs.setRepoLastActiveVendor).toHaveBeenCalledWith("/wt-root", "codex")
  })

  test("a stale worktree path never blocks the new tab (repo-root resolution throws)", async () => {
    state.sessionOptions = { "@kobe_worktree": "/gone", "@kobe_task": "t1" }
    vi.mocked(stateRepos.resolveMainRepoRoot).mockImplementationOnce(() => {
      throw new Error("not a git repository")
    })
    await chattab.newChatTab("kobe-t1", "codex")
    expect(vendorPrefs.setRepoLastActiveVendor).not.toHaveBeenCalled()
    const newWindowCall = state.capturingCalls.find((c) => c[0] === "new-window")
    expect(newWindowCall).toBeDefined()
  })

  test("degrades gracefully when new-window returns no pane id", async () => {
    state.newPaneId = ""
    await expect(chattab.newChatTab("kobe-t1")).resolves.toBeUndefined()
    // buildPanesAround never runs because there's no claude pane to build around.
    expect(callsWith("set-option")).toEqual([])
  })

  test("collapses the new tab immediately when the session is in zen mode", async () => {
    const layoutActions = await import("../../src/tui/panes/terminal/layout-actions")
    await chattab.newChatTab("kobe-t1")
    expect(layoutActions.applyZenToNewWindow).toHaveBeenCalledWith("kobe-t1", "%50")
  })
})

describe("dedicated single-page window openers", () => {
  test("openSettingsTab opens a surface window named settings", async () => {
    await chattab.openSettingsTab("kobe-t1")
    expect(state.newWindowCalls).toHaveLength(1)
    expect(state.newWindowCalls[0]).toMatchObject({ session: "kobe-t1", opts: { name: "settings", surface: true } })
    expect(state.newWindowCalls[0]?.opts.command).toContain("settings")
  })

  test("openHelpTab opens a surface window named help", async () => {
    await chattab.openHelpTab("kobe-t1")
    expect(state.newWindowCalls[0]).toMatchObject({ opts: { name: "help", surface: true } })
    expect(state.newWindowCalls[0]?.opts.command).toContain("help-page")
  })

  test("openNewTaskTab includes the default repo flag when given one", async () => {
    await chattab.openNewTaskTab("kobe-t1", "/repo/path")
    expect(state.newWindowCalls[0]?.opts.command).toContain("new-task")
    expect(state.newWindowCalls[0]?.opts.command).toContain("--repo")
    expect(state.newWindowCalls[0]?.opts.command).toContain("/repo/path")
  })

  test("openNewTaskTab omits --repo when no default is given", async () => {
    await chattab.openNewTaskTab("kobe-t1")
    expect(state.newWindowCalls[0]?.opts.command).not.toContain("--repo")
  })

  test("openUpdateTab opens the update page", async () => {
    await chattab.openUpdateTab("kobe-t1")
    expect(state.newWindowCalls[0]).toMatchObject({ opts: { name: "update", surface: true } })
  })

  test("quickCreate passes the session name through to the quick-task page", async () => {
    await chattab.quickCreate("kobe-t1")
    expect(state.newWindowCalls[0]).toMatchObject({ opts: { name: "quick task", surface: true } })
    expect(state.newWindowCalls[0]?.opts.command).toContain("quick-task")
    expect(state.newWindowCalls[0]?.opts.command).toContain("kobe-t1")
  })

  test("every opener no-ops when the session doesn't exist", async () => {
    state.existingSessions = new Set()
    await chattab.openSettingsTab("kobe-ghost")
    await chattab.openHelpTab("kobe-ghost")
    await chattab.openNewTaskTab("kobe-ghost")
    await chattab.openUpdateTab("kobe-ghost")
    await chattab.quickCreate("kobe-ghost")
    expect(state.newWindowCalls).toEqual([])
  })
})
