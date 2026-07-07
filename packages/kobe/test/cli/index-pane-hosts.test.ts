/**
 * Behavioral tests for the remaining `src/cli/index.ts` handlers — the
 * in-tmux hook handlers (heal-layout / resync-window / capture-layout) and
 * the pane/page host launches (quick-task / tasks / settings / help-page /
 * new-task / update-page / history / ops). Sibling of
 * index-dispatch.test.ts (same fresh-import + first-exit-throws technique).
 * The .tsx host modules are mocked — what's under test is the ROUTING:
 * required-flag validation, flag parsing, and which host gets which args.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const spies = vi.hoisted(() => ({
  healSessionLayout: vi.fn(async () => {}),
  resyncWindowToClient: vi.fn(async () => {}),
  captureGlobalLayoutOnDrag: vi.fn(async () => {}),
  coalesceLayoutWork: vi.fn(async (_s: string, _k: string, fn: () => Promise<void> | void) => {
    await fn()
  }),
  genAgeMs: vi.fn(() => 999_999),
  startQuickTaskHost: vi.fn(async () => {}),
  startTasksPane: vi.fn(async () => {}),
  startSettingsHost: vi.fn(async () => {}),
  startSettingsHostSolid: vi.fn(async () => {}),
  startHelpHost: vi.fn(async () => {}),
  startNewTaskHost: vi.fn(async () => {}),
  startUpdateHost: vi.fn(async () => {}),
  startHistoryHost: vi.fn(async () => {}),
  startOpsHost: vi.fn(async () => {}),
  startOpsPreview: vi.fn(async () => {}),
}))

vi.mock("../../src/tui/panes/terminal/tmux.ts", () => ({
  healSessionLayout: spies.healSessionLayout,
  resyncWindowToClient: spies.resyncWindowToClient,
  captureGlobalLayoutOnDrag: spies.captureGlobalLayoutOnDrag,
}))
vi.mock("../../src/tui/panes/terminal/layout-coord.ts", () => ({
  coalesceLayoutWork: spies.coalesceLayoutWork,
  genAgeMs: spies.genAgeMs,
  RESIZE_GUARD_MS: 500,
}))
vi.mock("../../src/tui/quick-task/host.tsx", () => ({ startQuickTaskHost: spies.startQuickTaskHost }))
vi.mock("../../src/tui/tasks-pane/host.tsx", () => ({ startTasksPane: spies.startTasksPane }))
vi.mock("../../src/tui/settings/host.tsx", () => ({ startSettingsHost: spies.startSettingsHostSolid }))
vi.mock("../../src/tui/help/host.tsx", () => ({ startHelpHost: spies.startHelpHost }))
vi.mock("../../src/tui/new-task/host.tsx", () => ({ startNewTaskHost: spies.startNewTaskHost }))
vi.mock("../../src/tui/update/host.tsx", () => ({ startUpdateHost: spies.startUpdateHost }))
vi.mock("../../src/tui/history/host.tsx", () => ({ startHistoryHost: spies.startHistoryHost }))
vi.mock("../../src/tui/ops/host.tsx", () => ({ startOpsHost: spies.startOpsHost }))
vi.mock("../../src/tui/ops/preview.tsx", () => ({ startOpsPreview: spies.startOpsPreview }))
// React is the default runtime (issue #16, `uiFramework()` in src/env.ts) for
// settings/help/history/ops — mock the React modules onto the SAME spies
// (help/history/ops) so those routing/flag-parsing tests don't care which
// runtime actually won. `settings` gets its OWN distinct pair of spies
// (`startSettingsHostSolid` above, `startSettingsHost` below) so one test
// can prove the KOBE_SOLID=1 escape hatch actually flips which module loads.
vi.mock("../../src/tui-react/settings/host.tsx", () => ({ startSettingsHost: spies.startSettingsHost }))
vi.mock("../../src/tui-react/help/host.tsx", () => ({ startHelpHost: spies.startHelpHost }))
vi.mock("../../src/tui-react/history/host.tsx", () => ({ startHistoryHost: spies.startHistoryHost }))
vi.mock("../../src/tui-react/ops/host.tsx", () => ({ startOpsHost: spies.startOpsHost }))
vi.mock("../../src/tui-react/ops/preview.tsx", () => ({ startOpsPreview: spies.startOpsPreview }))

let originalArgv: string[]
let originalKobeSolid: string | undefined
let exitSpy: ReturnType<typeof vi.fn>
let errorSpy: MockInstance

async function runCli(...args: string[]): Promise<void> {
  process.argv = ["bun", "/kobe/src/cli/index.ts", ...args]
  vi.resetModules()
  await import("../../src/cli/index.ts")
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  originalArgv = process.argv
  originalKobeSolid = process.env.KOBE_SOLID
  // Deterministic default (react) unless a test opts into the escape hatch.
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/repos.test.ts.
  delete process.env.KOBE_SOLID
  let exited = false
  exitSpy = vi.fn((code?: number) => {
    if (!exited) {
      exited = true
      throw new Error(`process.exit(${code}) sentinel`)
    }
  })
  vi.spyOn(process, "exit").mockImplementation(exitSpy as unknown as typeof process.exit)
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  process.argv = originalArgv
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/repos.test.ts.
  if (originalKobeSolid === undefined) delete process.env.KOBE_SOLID
  else process.env.KOBE_SOLID = originalKobeSolid
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("tmux hook handlers", () => {
  test("heal-layout requires --session, then runs the coalesced heal", async () => {
    await runCli("heal-layout")
    expect(exitSpy).toHaveBeenCalledWith(2)

    vi.clearAllMocks()
    await runCli("heal-layout", "--session", "kobe-t1")
    expect(spies.coalesceLayoutWork).toHaveBeenCalledWith("kobe-t1", "heal", expect.any(Function))
    expect(spies.healSessionLayout).toHaveBeenCalledWith("kobe-t1")
  })

  test("resync-window passes valid client dims through, degrading garbage to null", async () => {
    await runCli("resync-window", "--session", "kobe-t1", "--cols", "200", "--rows", "50", "--status", "on")
    expect(spies.resyncWindowToClient).toHaveBeenCalledWith("kobe-t1", {
      size: { columns: 200, rows: 50 },
      status: "on",
      clientName: undefined,
    })

    vi.clearAllMocks()
    await runCli("resync-window", "--session", "kobe-t1", "--cols", "garbage", "--rows", "50")
    expect(spies.resyncWindowToClient).toHaveBeenCalledWith("kobe-t1", expect.objectContaining({ size: null }))
  })

  test("resync-window forwards the resized tmux client's name from --client", async () => {
    await runCli("resync-window", "--session", "kobe-t1", "--cols", "80", "--rows", "24", "--client", "/dev/ttys003")
    expect(spies.resyncWindowToClient).toHaveBeenCalledWith(
      "kobe-t1",
      expect.objectContaining({ clientName: "/dev/ttys003" }),
    )
  })

  test("resync-window without --session errors with exit 2", async () => {
    await runCli("resync-window", "--cols", "80", "--rows", "24")
    expect(errorSpy).toHaveBeenCalledWith("kobe resync-window: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.resyncWindowToClient).not.toHaveBeenCalled()
  })

  test("capture-layout without --session errors with exit 2", async () => {
    await runCli("capture-layout")
    expect(errorSpy).toHaveBeenCalledWith("kobe capture-layout: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.captureGlobalLayoutOnDrag).not.toHaveBeenCalled()
  })

  test("capture-layout skips the capture while a resize is in flight", async () => {
    spies.genAgeMs.mockReturnValue(10) // fresh resize stamp — inside the guard window
    await runCli("capture-layout", "--session", "kobe-t1")
    expect(spies.captureGlobalLayoutOnDrag).not.toHaveBeenCalled()

    vi.clearAllMocks()
    spies.genAgeMs.mockReturnValue(999_999)
    await runCli("capture-layout", "--session", "kobe-t1")
    expect(spies.captureGlobalLayoutOnDrag).toHaveBeenCalledWith("kobe-t1")
  })
})

describe("pane / page host launches", () => {
  test("quick-task forwards the session for default resolution", async () => {
    await runCli("quick-task", "--session", "kobe-t1")
    expect(spies.startQuickTaskHost).toHaveBeenCalledWith({ session: "kobe-t1" })
  })

  test("tasks forwards the initial row selection", async () => {
    await runCli("tasks", "--initial-task-id", "t42")
    expect(spies.startTasksPane).toHaveBeenCalledWith({ initialTaskId: "t42" })
  })

  test("settings / help-page / update-page launch their full-window surfaces", async () => {
    await runCli("settings")
    expect(spies.startSettingsHost).toHaveBeenCalled()
    expect(spies.startSettingsHostSolid).not.toHaveBeenCalled()
    await runCli("help-page")
    expect(spies.startHelpHost).toHaveBeenCalled()
    await runCli("update-page")
    expect(spies.startUpdateHost).toHaveBeenCalled()
  })

  test("KOBE_SOLID=1 is the legacy escape hatch back to the Solid settings host", async () => {
    process.env.KOBE_SOLID = "1"
    await runCli("settings")
    expect(spies.startSettingsHostSolid).toHaveBeenCalled()
    expect(spies.startSettingsHost).not.toHaveBeenCalled()
  })

  test("new-task pre-selects the repo picker from --repo", async () => {
    await runCli("new-task", "--repo", "/repo")
    expect(spies.startNewTaskHost).toHaveBeenCalledWith({ defaultRepo: "/repo" })
  })

  test("history requires --worktree and passes vendor/title/--live through", async () => {
    await runCli("history")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(errorSpy).toHaveBeenCalledWith("kobe history: --worktree <path> is required")

    vi.clearAllMocks()
    await runCli("history", "--worktree", "/wt", "--vendor", "codex", "--title", "My Task", "--live")
    expect(spies.startHistoryHost).toHaveBeenCalledWith({
      worktree: "/wt",
      vendor: "codex",
      title: "My Task",
      live: true,
    })
  })

  test("ops requires --worktree, then launches the FileTree host with the pane wiring", async () => {
    await runCli("ops")
    expect(exitSpy).toHaveBeenCalledWith(2)

    vi.clearAllMocks()
    await runCli("ops", "--worktree", "/wt", "--task-id", "t1", "--target-pane", "%0", "--vendor", "claude")
    expect(spies.startOpsHost).toHaveBeenCalledWith({
      taskId: "t1",
      worktree: "/wt",
      targetPane: "%0",
      vendor: "claude",
    })
    expect(spies.startOpsPreview).not.toHaveBeenCalled()
  })

  test("ops --preview routes to the full-width preview instead of the FileTree", async () => {
    await runCli("ops", "--worktree", "/wt", "--preview", "src/a.ts")
    expect(spies.startOpsPreview).toHaveBeenCalledWith({ worktree: "/wt", relPath: "src/a.ts" })
    expect(spies.startOpsHost).not.toHaveBeenCalled()
  })
})
