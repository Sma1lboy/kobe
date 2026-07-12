/**
 * Behavioral tests for the CLI entry dispatcher (`src/cli/index.ts`).
 *
 * The module runs `main()` at import time, so each test resets the module
 * registry, sets `process.argv`, imports the entry fresh, and flushes the
 * microtask queue. Every subcommand module is mocked at the seam the entry
 * dynamically imports, so a test asserts exactly one thing: the argv
 * routed to the right handler with the right rest-args (or printed the
 * right usage/error and exit code). `process.exit` throws a sentinel on
 * its FIRST call (so the code after an exit really stops, like production)
 * and no-ops afterwards — main()'s top-level .catch calls exit(1) again,
 * and a second throw there would surface as an unhandled rejection.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const spies = vi.hoisted(() => ({
  completions: vi.fn(async () => {}),
  exportCmd: vi.fn(async () => {}),
  repo: vi.fn(async () => {}),
  api: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  theme: vi.fn(async () => {}),
  feedback: vi.fn(async () => {}),
  daemon: vi.fn(async () => {}),
  doctor: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  web: vi.fn(async () => {}),
  skill: vi.fn(async () => {}),
  hook: vi.fn(async () => {}),
  addRemote: vi.fn(async () => {}),
  startTui: vi.fn(async () => {}),
  newChatTab: vi.fn(async () => {}),
  quickCreate: vi.fn(async () => {}),
  selectTasksPane: vi.fn(async () => {}),
  runLayoutAction: vi.fn(async () => {}),
  engineTabExit: vi.fn(async () => {}),
  windowIsSurface: vi.fn(async () => false),
  runTmux: vi.fn(async (_args: string[]) => 0),
  termAllPaneGroups: vi.fn(async () => {}),
  setPersistedString: vi.fn(),
}))

vi.mock("../../src/cli/completions-cmd.ts", () => ({ runCompletionsSubcommand: spies.completions }))
vi.mock("../../src/cli/export-cmd.ts", () => ({ runExportSubcommand: spies.exportCmd }))
vi.mock("../../src/cli/repo-cmd.ts", () => ({ runRepoSubcommand: spies.repo }))
vi.mock("../../src/cli/api-cmd.ts", () => ({ runApiSubcommand: spies.api }))
vi.mock("../../src/cli/update.ts", () => ({ runUpdateSubcommand: spies.update }))
vi.mock("../../src/cli/theme.ts", () => ({ runThemeSubcommand: spies.theme }))
vi.mock("../../src/cli/feedback-cmd.ts", () => ({ runFeedbackSubcommand: spies.feedback }))
vi.mock("../../src/cli/daemon-cmd.ts", () => ({ runDaemonSubcommand: spies.daemon }))
vi.mock("../../src/cli/maintenance.ts", () => ({
  runDoctorSubcommand: spies.doctor,
  runResetSubcommand: spies.reset,
  runReloadSubcommand: spies.reload,
}))
vi.mock("../../src/cli/web-cmd.ts", () => ({ runWebSubcommand: spies.web }))
vi.mock("../../src/cli/skill-cmd.ts", () => ({ runSkillSubcommand: spies.skill }))
vi.mock("../../src/cli/hook-cmd.ts", () => ({ runHookSubcommand: spies.hook }))
vi.mock("../../src/cli/add-remote.ts", () => ({ runAddRemote: spies.addRemote }))
vi.mock("../../src/tui/index.tsx", () => ({ startTui: spies.startTui }))
vi.mock("../../src/tmux/client.ts", () => ({
  windowIsSurface: spies.windowIsSurface,
  runTmux: spies.runTmux,
  termAllPaneGroups: spies.termAllPaneGroups,
  KOBE_TMUX_SOCKET: "kobe",
}))
vi.mock("../../src/tui/panes/terminal/tmux.ts", () => ({
  newChatTab: spies.newChatTab,
  quickCreate: spies.quickCreate,
  selectTasksPane: spies.selectTasksPane,
  runLayoutAction: spies.runLayoutAction,
}))
vi.mock("../../src/tui/panes/terminal/layout-actions.ts", () => ({ engineTabExit: spies.engineTabExit }))
vi.mock("../../src/state/repos.ts", () => ({
  addSavedRepo: vi.fn(() => ({ added: true, path: "/repo", total: 1 })),
  isGitRepo: vi.fn(() => true),
  getSavedRepos: vi.fn(() => [] as string[]),
  resolveRepoRoot: vi.fn((p: string) => p),
  getCustomEngineIds: vi.fn(() => [] as string[]),
  setPersistedString: spies.setPersistedString,
}))
vi.mock("../../src/orchestrator/index/store.ts", () => ({
  TaskIndexStore: class {
    async load() {}
  },
}))
vi.mock("../../src/orchestrator/worktree/manager.ts", () => ({ GitWorktreeManager: class {} }))
vi.mock("../../src/orchestrator/core.ts", () => ({
  Orchestrator: class {
    async discoverAdoptableWorktrees() {
      return []
    }
    async forgetProject() {}
    async adoptWorktree() {
      return { id: "t1", title: "adopted" }
    }
  },
}))
vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectIfRunning: vi.fn(async () => null),
}))

let originalArgv: string[]
let exitSpy: ReturnType<typeof vi.fn>
let logSpy: MockInstance
let errorSpy: MockInstance
let stdoutSpy: MockInstance
let stderrSpy: MockInstance

async function runCli(...args: string[]): Promise<void> {
  process.argv = ["bun", "/kobe/src/cli/index.ts", ...args]
  vi.resetModules()
  await import("../../src/cli/index.ts")
  // main() runs detached at import time; flush the mocked-async chain.
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("")
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("")
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
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("version / help / unknown", () => {
  test("--version prints the current version", async () => {
    await runCli("--version")
    const { CURRENT_VERSION } = await import("../../src/version.ts")
    expect(logSpy).toHaveBeenCalledWith(`kobe ${CURRENT_VERSION}`)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("--help prints usage to stdout and exits cleanly", async () => {
    await runCli("--help")
    expect(stdoutText()).toContain("kobe")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("an unknown subcommand prints usage to stderr and exits 2 (never launches the TUI)", async () => {
    await runCli("statsu")
    expect(errorSpy).toHaveBeenCalledWith("kobe: unknown command 'statsu'")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.startTui).not.toHaveBeenCalled()
  })

  test("a bare `kobe` launches PureTUI", async () => {
    await runCli()
    expect(spies.startTui).toHaveBeenCalledWith("puretui")
  })

  test.each([
    ["--puretui", "puretui"],
    ["--tmux", "tmux"],
  ] as const)("kobe %s launches %s", async (flag, mode) => {
    await runCli(flag)
    expect(spies.startTui).toHaveBeenCalledWith(mode)
  })

  test("conflicting launch flags print usage and launch nothing", async () => {
    await runCli("--tmux", "--puretui")
    expect(stderrText()).toContain("cannot be used together")
    expect(stderrText()).toContain("Usage: kobe")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.startTui).not.toHaveBeenCalled()
  })
})

describe("subcommand routing", () => {
  const routes: Array<[string[], keyof typeof spies, string[]]> = [
    [["completions", "zsh"], "completions", ["zsh"]],
    [["export", "--csv"], "exportCmd", ["--csv"]],
    [["repo", "list"], "repo", ["list"]],
    [["api", "send", "hi"], "api", ["send", "hi"]],
    [["update"], "update", []],
    [["theme", "list"], "theme", ["list"]],
    [["feedback"], "feedback", []],
    [["daemon", "status"], "daemon", ["status"]],
    [["doctor"], "doctor", []],
    [["web"], "web", []],
    [["reset", "--hard"], "reset", ["--hard"]],
    [["reload"], "reload", []],
    [["skill", "install"], "skill", ["install"]],
    [["hook", "claude"], "hook", ["claude"]],
  ]
  for (const [argv, spy, rest] of routes) {
    test(`kobe ${argv.join(" ")} → ${String(spy)}(${JSON.stringify(rest)})`, async () => {
      await runCli(...argv)
      expect(spies[spy]).toHaveBeenCalledWith(rest)
    })
  }

  test("kobe add --remote routes to the remote flow with the remaining flags", async () => {
    await runCli("add", "--remote", "--host", "box")
    expect(spies.addRemote).toHaveBeenCalledWith(["--host", "box"])
  })
})

describe("in-session handlers (new-chattab / focus-tasks / layout / kill-sessions)", () => {
  test("new-chattab without --session errors with exit 2", async () => {
    await runCli("new-chattab")
    expect(errorSpy).toHaveBeenCalledWith("kobe new-chattab: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
  })

  test("new-chattab on a surface window is a deliberate no-op", async () => {
    spies.windowIsSurface.mockResolvedValueOnce(true)
    await runCli("new-chattab", "--session", "kobe-t1")
    expect(spies.newChatTab).not.toHaveBeenCalled()
  })

  test("new-chattab opens a tab in the session, honoring a valid --vendor", async () => {
    await runCli("new-chattab", "--session", "kobe-t1", "--vendor", "codex")
    // Per-repo last-active persistence happens inside newChatTab (mocked here).
    expect(spies.newChatTab).toHaveBeenCalledWith("kobe-t1", "codex")
  })

  test("new-chattab rejects an unknown engine VISIBLY via tmux display-message", async () => {
    await runCli("new-chattab", "--session", "kobe-t1", "--vendor", "gpt9")
    expect(spies.newChatTab).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(2)
    const display = spies.runTmux.mock.calls.find((c) => c[0][0] === "display-message")
    expect(display).toBeDefined()
    expect(display?.[0].join(" ")).toContain("unknown engine 'gpt9'")
  })

  test("focus-tasks selects the Tasks pane, skipping surface windows", async () => {
    await runCli("focus-tasks", "--session", "kobe-t1", "--window", "@2")
    expect(spies.selectTasksPane).toHaveBeenCalledWith("kobe-t1", { windowId: "@2" })

    vi.clearAllMocks()
    spies.windowIsSurface.mockResolvedValueOnce(true)
    await runCli("focus-tasks", "--session", "kobe-t1", "--window", "@9")
    expect(spies.selectTasksPane).not.toHaveBeenCalled()
  })

  test("layout validates --action against the whitelist", async () => {
    await runCli("layout", "--session", "kobe-t1", "--action", "explode")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.runLayoutAction).not.toHaveBeenCalled()
  })

  test("layout runs a valid action against the firing window", async () => {
    await runCli("layout", "--session", "kobe-t1", "--window", "@3", "--action", "ops-toggle")
    expect(spies.runLayoutAction).toHaveBeenCalledWith("kobe-t1", "ops-toggle", { windowId: "@3" })
  })

  test("layout tasks-restore is surface-guarded like the other root chords", async () => {
    spies.windowIsSurface.mockResolvedValueOnce(true)
    await runCli("layout", "--session", "kobe-t1", "--window", "@3", "--action", "tasks-restore")
    expect(spies.runLayoutAction).not.toHaveBeenCalled()
  })

  test("engine-tab-exit requires --session and then delegates", async () => {
    await runCli("engine-tab-exit")
    expect(exitSpy).toHaveBeenCalledWith(2)
    vi.clearAllMocks()
    await runCli("engine-tab-exit", "--session", "kobe-t1")
    expect(spies.engineTabExit).toHaveBeenCalledWith("kobe-t1")
  })

  test("quick-create requires --session and then delegates", async () => {
    await runCli("quick-create")
    expect(errorSpy).toHaveBeenCalledWith("kobe quick-create: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.quickCreate).not.toHaveBeenCalled()

    vi.clearAllMocks()
    await runCli("quick-create", "--session", "kobe-t1")
    expect(spies.quickCreate).toHaveBeenCalledWith("kobe-t1")
  })

  test("focus-tasks without --session errors with exit 2", async () => {
    await runCli("focus-tasks")
    expect(errorSpy).toHaveBeenCalledWith("kobe focus-tasks: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.selectTasksPane).not.toHaveBeenCalled()
  })

  test("layout without --session errors with exit 2 before validating the action", async () => {
    await runCli("layout", "--action", "ops-toggle")
    expect(errorSpy).toHaveBeenCalledWith("kobe layout: --session <name> is required")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(spies.runLayoutAction).not.toHaveBeenCalled()
  })

  test("kill-sessions TERMs every pane group BEFORE killing the server", async () => {
    await runCli("kill-sessions")
    expect(spies.termAllPaneGroups).toHaveBeenCalled()
    expect(spies.runTmux).toHaveBeenCalledWith(["kill-server"])
    const termOrder = spies.termAllPaneGroups.mock.invocationCallOrder[0] ?? 0
    const killOrder = spies.runTmux.mock.invocationCallOrder[0] ?? 0
    expect(termOrder).toBeLessThan(killOrder)
  })

  test("kill-sessions reports 'no sessions' when the server wasn't running", async () => {
    spies.runTmux.mockResolvedValueOnce(1)
    await runCli("kill-sessions")
    expect(logSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("no tmux sessions to kill")
  })
})
