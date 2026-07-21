/** CLI entry routing: public commands, sole TUI launch, and retired surfaces. */

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
  web: vi.fn(async () => {}),
  skill: vi.fn(async () => {}),
  hook: vi.fn(async () => {}),
  addRemote: vi.fn(async () => {}),
  openDirectory: vi.fn(async () => {}),
  startTui: vi.fn(async () => {}),
  onboarding: vi.fn(async () => false),
}))

vi.mock("../../src/cli/completions-cmd.ts", () => ({ runCompletionsSubcommand: spies.completions }))
vi.mock("../../src/cli/export-cmd.ts", () => ({ runExportSubcommand: spies.exportCmd }))
vi.mock("../../src/cli/repo-cmd.ts", () => ({ runRepoSubcommand: spies.repo }))
vi.mock("../../src/cli/api-cmd.ts", () => ({ runApiSubcommand: spies.api }))
vi.mock("../../src/cli/update.ts", () => ({ runUpdateSubcommand: spies.update }))
vi.mock("../../src/cli/theme.ts", () => ({ runThemeSubcommand: spies.theme }))
vi.mock("../../src/cli/feedback-cmd.ts", () => ({ runFeedbackSubcommand: spies.feedback }))
vi.mock("../../src/cli/daemon-cmd.ts", () => ({ runDaemonSubcommand: spies.daemon }))
vi.mock("../../src/cli/doctor-cmd.ts", () => ({ runDoctorSubcommand: spies.doctor }))
vi.mock("../../src/cli/reset-cmd.ts", () => ({ runResetSubcommand: spies.reset }))
vi.mock("../../src/cli/web-cmd.ts", () => ({ runWebSubcommand: spies.web }))
vi.mock("../../src/cli/skill-cmd.ts", () => ({ runSkillSubcommand: spies.skill }))
vi.mock("../../src/cli/hook-cmd.ts", () => ({ runHookSubcommand: spies.hook }))
vi.mock("../../src/cli/add-remote.ts", () => ({ runAddRemote: spies.addRemote }))
vi.mock("../../src/cli/open-dir-cmd.ts", async (importOriginal) => ({
  // Real isPathLikeArg (the routing predicate under test), spied executor.
  ...(await importOriginal<typeof import("../../src/cli/open-dir-cmd.ts")>()),
  runOpenDirectory: spies.openDirectory,
}))
vi.mock("../../src/cli/onboarding.ts", () => ({ maybeRunOnboarding: spies.onboarding }))
vi.mock("../../src/tui/index.tsx", () => ({ startTui: spies.startTui }))

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
  // Bare launch performs two sequential dynamic imports (terminal-title,
  // then onboarding) before it may import the TUI. Drain enough turns for
  // that fire-and-forget main() chain to settle before assertions run.
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve))
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((call) => String(call[0])).join("")
}

beforeEach(() => {
  originalArgv = process.argv
  spies.onboarding.mockResolvedValue(false)
  let exited = false
  exitSpy = vi.fn((code?: number) => {
    if (exited) return
    exited = true
    throw new Error(`process.exit(${code}) sentinel`)
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

describe("version, help, launch, and unknown commands", () => {
  test("--version prints the current version", async () => {
    await runCli("--version")
    const { CURRENT_VERSION } = await import("../../src/version.ts")
    expect(logSpy).toHaveBeenCalledWith(`kobe ${CURRENT_VERSION}`)
  })

  test("--help prints usage", async () => {
    await runCli("--help")
    expect(stdoutText()).toContain("Usage: kobe")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("bare kobe launches the sole TUI after onboarding is complete", async () => {
    await runCli()
    await vi.waitFor(() => expect(spies.onboarding).toHaveBeenCalled())
    await vi.waitFor(() => expect(spies.startTui).toHaveBeenCalledWith())
  })

  test("a first run hands launch to onboarding instead of the TUI", async () => {
    spies.onboarding.mockResolvedValueOnce(true)
    await runCli()
    await vi.waitFor(() => expect(spies.onboarding).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
    expect(spies.startTui).not.toHaveBeenCalled()
  })

  test.each(["--tmux", "--puretui", "reload", "kill-sessions"])(
    "retired surface %s is an unknown command",
    async (command) => {
      await runCli(command)
      expect(errorSpy).toHaveBeenCalledWith(`kobe: unknown command '${command}'`)
      expect(exitSpy).toHaveBeenCalledWith(2)
      expect(spies.startTui).not.toHaveBeenCalled()
    },
  )
})

describe("public subcommand routing", () => {
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
    [["reset", "--yes"], "reset", ["--yes"]],
    [["web"], "web", []],
    [["skill", "install"], "skill", ["install"]],
    [["hook", "claude"], "hook", ["claude"]],
  ]

  for (const [argv, spy, rest] of routes) {
    test(`kobe ${argv.join(" ")} routes to ${String(spy)}`, async () => {
      await runCli(...argv)
      expect(spies[spy]).toHaveBeenCalledWith(rest)
    })
  }

  test("add --remote forwards remaining flags", async () => {
    await runCli("add", "--remote", "--host", "box")
    expect(spies.addRemote).toHaveBeenCalledWith(["--host", "box"])
  })

  test.each([".", "..", "./x", "/abs/path", "~/x"])("kobe %s routes to open-directory", async (arg) => {
    await runCli(arg)
    expect(spies.openDirectory).toHaveBeenCalledWith(arg)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("a bare word is still an unknown command, not a directory guess", async () => {
    await runCli("statsu")
    expect(spies.openDirectory).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith("kobe: unknown command 'statsu'")
    expect(exitSpy).toHaveBeenCalledWith(2)
  })
})
