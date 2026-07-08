/**
 * Behavioral tests for the remaining `src/cli/index.ts` handlers — the
 * in-tmux hook handlers (heal-layout / resync-window / capture-layout) and
 * the pane/page host launches (settings / help-page / history / ops).
 * Sibling of index-dispatch.test.ts (same fresh-import + first-exit-throws
 * technique). React is the only runtime, so the host modules under
 * `src/tui-react/**` are mocked — what's under test is the ROUTING:
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
  startSettingsHost: vi.fn(async () => {}),
  startHelpHost: vi.fn(async () => {}),
  startHistoryHost: vi.fn(async () => {}),
  startOpsHost: vi.fn(async () => {}),
  startOpsPreview: vi.fn(async () => {}),
  startTasksPane: vi.fn(async () => {}),
  startNewTaskHost: vi.fn(async () => {}),
  startQuickTaskHost: vi.fn(async () => {}),
  startUpdateHost: vi.fn(async () => {}),
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
vi.mock("../../src/tui-react/settings/host.tsx", () => ({ startSettingsHost: spies.startSettingsHost }))
vi.mock("../../src/tui-react/help/host.tsx", () => ({ startHelpHost: spies.startHelpHost }))
vi.mock("../../src/tui-react/history/host.tsx", () => ({ startHistoryHost: spies.startHistoryHost }))
vi.mock("../../src/tui-react/ops/host.tsx", () => ({ startOpsHost: spies.startOpsHost }))
vi.mock("../../src/tui-react/ops/preview.tsx", () => ({ startOpsPreview: spies.startOpsPreview }))
vi.mock("../../src/tui-react/tasks-pane/host.tsx", () => ({ startTasksPane: spies.startTasksPane }))
vi.mock("../../src/tui-react/new-task/host.tsx", () => ({ startNewTaskHost: spies.startNewTaskHost }))
vi.mock("../../src/tui-react/quick-task/host.tsx", () => ({ startQuickTaskHost: spies.startQuickTaskHost }))
vi.mock("../../src/tui-react/update/host.tsx", () => ({ startUpdateHost: spies.startUpdateHost }))

let originalArgv: string[]
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
  test("settings / help-page launch their full-window surfaces", async () => {
    await runCli("settings")
    expect(spies.startSettingsHost).toHaveBeenCalled()
    await runCli("help-page")
    expect(spies.startHelpHost).toHaveBeenCalled()
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

  // The tmux product path spawns these four in every task session (Tasks
  // rail, prefix-f quick create, new-task window, update window). They were
  // silently dropped when the Solid TUI was removed (7a5b878d) — the rail
  // printed "unknown command" — so this pins the routing for good.
  test("tasks launches the Tasks pane, forwarding --initial-task-id", async () => {
    await runCli("tasks")
    expect(spies.startTasksPane).toHaveBeenCalledWith({ initialTaskId: undefined })

    vi.clearAllMocks()
    await runCli("tasks", "--initial-task-id", "t42")
    expect(spies.startTasksPane).toHaveBeenCalledWith({ initialTaskId: "t42" })
  })

  test("new-task launches the full-window page, forwarding --repo", async () => {
    await runCli("new-task", "--repo", "/repo/a")
    expect(spies.startNewTaskHost).toHaveBeenCalledWith({ defaultRepo: "/repo/a" })
  })

  test("quick-task launches the prompt-first page, forwarding --session", async () => {
    await runCli("quick-task", "--session", "kobe-t1")
    expect(spies.startQuickTaskHost).toHaveBeenCalledWith({ session: "kobe-t1" })
  })

  test("update-page launches the update surface", async () => {
    await runCli("update-page")
    expect(spies.startUpdateHost).toHaveBeenCalled()
  })
})
