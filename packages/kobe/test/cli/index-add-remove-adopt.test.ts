/**
 * Behavioral tests for the `kobe add` / `kobe remove` / `kobe adopt`
 * subcommands in `src/cli/index.ts` — the sibling of
 * `index-dispatch.test.ts` (same fresh-import + first-exit-throws
 * technique; see that file's header). Here the state/orchestrator/daemon
 * seams are stateful fakes so the tests assert real flow decisions:
 * which target `remove` matches, when `add` folds worktrees in, and when
 * `adopt` requires the glob + `--yes` gate.
 */

import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { AdoptableWorktree } from "../../src/types/worktree"

const fake = vi.hoisted(() => ({
  savedRepos: [] as string[],
  isGitRepo: true,
  repoRootOf: {} as Record<string, string>,
  adoptable: [] as Array<{ path: string; branch: string; dirty?: boolean; kobeManaged?: boolean }>,
  discoverError: null as Error | null,
  addSavedRepo: vi.fn((p: string) => ({ added: true, path: p, total: 1 })),
  adoptWorktree: vi.fn(async (args: { worktreePath: string }) => ({
    id: `task-${args.worktreePath.split("/").pop()}`,
    title: "adopted",
  })),
  forgetProject: vi.fn(async (_repo: string) => {}),
  ensureMainTask: vi.fn(async (repo: string) => ({ id: "main-1", kind: "main", repo })),
  daemonClient: null as null | { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> },
}))

vi.mock("../../src/state/repos.ts", () => ({
  addSavedRepo: fake.addSavedRepo,
  isGitRepo: vi.fn(() => fake.isGitRepo),
  getSavedRepos: vi.fn(() => fake.savedRepos),
  resolveRepoRoot: vi.fn((p: string) => fake.repoRootOf[p] ?? p),
  getCustomEngineIds: vi.fn(() => [] as string[]),
  setPersistedString: vi.fn(),
}))
vi.mock("../../src/orchestrator/index/store.ts", () => ({
  TaskIndexStore: class {
    async load() {}
  },
}))
vi.mock("../../src/orchestrator/worktree/manager.ts", () => ({ GitWorktreeManager: class {} }))
vi.mock("../../src/orchestrator/core.ts", () => ({
  Orchestrator: class {
    async discoverAdoptableWorktrees(): Promise<AdoptableWorktree[]> {
      if (fake.discoverError) throw fake.discoverError
      return fake.adoptable.map((w) => ({
        path: w.path,
        branch: w.branch,
        dirty: w.dirty ?? false,
        kobeManaged: w.kobeManaged ?? true,
      })) as unknown as AdoptableWorktree[]
    }
    async forgetProject(repo: string) {
      await fake.forgetProject(repo)
    }
    async ensureMainTask(repo: string) {
      return fake.ensureMainTask(repo)
    }
    async adoptWorktree(args: { worktreePath: string }) {
      return fake.adoptWorktree(args)
    }
  },
}))
vi.mock("@sma1lboy/kobe-daemon/client/daemon-process", () => ({
  connectIfRunning: vi.fn(async () => fake.daemonClient),
}))

let originalArgv: string[]
let exitSpy: ReturnType<typeof vi.fn>
let logSpy: MockInstance
let stderrSpy: MockInstance
let stdoutSpy: MockInstance

async function runCli(...args: string[]): Promise<void> {
  process.argv = ["bun", "/kobe/src/cli/index.ts", ...args]
  vi.resetModules()
  await import("../../src/cli/index.ts")
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r))
}

function logText(): string {
  return logSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n")
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("")
}

beforeEach(() => {
  fake.savedRepos = []
  fake.isGitRepo = true
  fake.repoRootOf = {}
  fake.adoptable = []
  fake.discoverError = null
  fake.daemonClient = null
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
  vi.spyOn(console, "error").mockImplementation(() => {})
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  process.argv = originalArgv
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe("kobe add", () => {
  test("saves a git repo and reports the total", async () => {
    await runCli("add", "/repo")
    expect(fake.addSavedRepo).toHaveBeenCalledWith("/repo")
    expect(logText()).toContain("added /repo (1 saved repo total)")
    // The repo's main task (= the sidebar PROJECTS row) is provisioned even
    // when there are no worktrees to adopt — no daemon running → in-process.
    expect(fake.ensureMainTask).toHaveBeenCalledWith("/repo")
  })

  test("rejects a non-git path with exit 1 before polluting the picker", async () => {
    fake.isGitRepo = false
    await runCli("add", ",")
    expect(fake.addSavedRepo).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain("is not a git repository")
  })

  test("rejects an unknown flag with exit 2 and the usage text", async () => {
    await runCli("add", "--frobnicate")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain("unknown flag")
  })

  test("--help prints usage without saving anything", async () => {
    await runCli("add", "--help")
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("Usage: kobe add")
    expect(fake.addSavedRepo).not.toHaveBeenCalled()
  })

  test("folds the repo's unlinked worktrees in as tasks (KOB-256)", async () => {
    fake.adoptable = [{ path: "/repo/.claude/worktrees/lynx", branch: "kobe/lynx" }]
    await runCli("add", "/repo")
    expect(fake.adoptWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "/repo/.claude/worktrees/lynx" }),
    )
    expect(logText()).toContain("importing")
    expect(logText()).toContain("adopted kobe/lynx")
  })

  test("a worktree-scan failure is reported but does not fail the add", async () => {
    fake.discoverError = new Error("git broke")
    await runCli("add", "/repo")
    expect(fake.addSavedRepo).toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("an already-saved repo says so instead of re-adding", async () => {
    fake.addSavedRepo.mockImplementationOnce((p: string) => ({ added: false, path: p, total: 3 }))
    await runCli("add", "/repo")
    expect(logText()).toContain("already saved: /repo")
    expect(logText()).not.toContain("added /repo")
  })

  test("adopts through a RUNNING daemon when one is up (live TUI updates)", async () => {
    fake.adoptable = [{ path: "/repo/wt-a", branch: "kobe/a" }]
    const request = vi.fn(async () => ({ task: { id: "d1", title: "via-daemon" } }))
    const close = vi.fn()
    fake.daemonClient = { request, close }
    await runCli("add", "/repo")
    expect(request).toHaveBeenCalledWith("worktree.adopt", {
      repo: "/repo",
      worktreePath: "/repo/wt-a",
      branch: "kobe/a",
      vendor: "claude",
    })
    expect(close).toHaveBeenCalled()
    // The in-process orchestrator write path is NOT used when the daemon answers.
    expect(fake.adoptWorktree).not.toHaveBeenCalled()
    expect(logText()).toContain("adopted kobe/a → task d1 (via-daemon)")
    // Main-task provisioning also rides the daemon so the live TUI's
    // PROJECTS list gains the repo immediately.
    expect(request).toHaveBeenCalledWith("task.ensureMain", { repo: "/repo" })
    expect(fake.ensureMainTask).not.toHaveBeenCalled()
  })
})

describe("kobe remove", () => {
  test("--help prints usage without forgetting anything", async () => {
    fake.savedRepos = ["/repo"]
    await runCli("remove", "--help")
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("Usage: kobe remove")
    expect(fake.forgetProject).not.toHaveBeenCalled()
  })

  test("rejects an unknown flag with exit 2 and the usage text", async () => {
    await runCli("remove", "--frobnicate")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain('unknown flag "--frobnicate"')
    expect(stderrText()).toContain("Usage: kobe remove")
  })

  test("with nothing saved, says so and exits cleanly", async () => {
    await runCli("remove", "/repo")
    expect(logText()).toContain("no saved projects to remove")
    expect(exitSpy).not.toHaveBeenCalled()
  })

  test("an exact saved entry (e.g. a garbage or ssh:// key) is removable verbatim", async () => {
    fake.savedRepos = ["ssh://dev@box", "/repo"]
    await runCli("remove", "ssh://dev@box")
    expect(fake.forgetProject).toHaveBeenCalledWith("ssh://dev@box")
  })

  test("a subdirectory resolves to its git toplevel before matching", async () => {
    fake.savedRepos = ["/repo"]
    fake.repoRootOf["/repo/packages/sub"] = "/repo"
    await runCli("remove", "/repo/packages/sub")
    expect(fake.forgetProject).toHaveBeenCalledWith("/repo")
  })

  test("no match prints the saved list to stderr and exits 1", async () => {
    fake.savedRepos = ["/other"]
    await runCli("remove", "/nope")
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrText()).toContain("/other")
    expect(fake.forgetProject).not.toHaveBeenCalled()
  })

  test("prefers a RUNNING daemon so a live TUI updates", async () => {
    fake.savedRepos = ["/repo"]
    const request = vi.fn(async () => ({}))
    const close = vi.fn()
    fake.daemonClient = { request, close }
    await runCli("remove", "/repo")
    expect(request).toHaveBeenCalledWith("project.forget", { repo: "/repo" })
    expect(close).toHaveBeenCalled()
    expect(fake.forgetProject).not.toHaveBeenCalled()
  })
})

describe("kobe adopt", () => {
  test("no adoptable worktrees → friendly message, no daemon touch", async () => {
    await runCli("adopt")
    expect(logText()).toContain("no adoptable worktrees")
  })

  test("no glob → dry-run listing plus the how-to hint", async () => {
    fake.adoptable = [{ path: "/repo/wt-a", branch: "a", dirty: true, kobeManaged: false }]
    await runCli("adopt")
    expect(logText()).toContain("adoptable worktrees in")
    expect(logText()).toContain("dirty")
    expect(logText()).toContain("external")
    expect(logText()).toContain("pass a path glob to adopt")
    expect(fake.adoptWorktree).not.toHaveBeenCalled()
  })

  test("a glob without --yes lists matches and stops at the confirmation gate", async () => {
    fake.adoptable = [
      { path: "/repo/wt-a", branch: "a" },
      { path: "/repo/other", branch: "b" },
    ]
    await runCli("adopt", "/repo/wt-*")
    expect(logText()).toContain("1 worktree(s) match")
    expect(fake.adoptWorktree).not.toHaveBeenCalled()
  })

  test("a glob matching nothing says so", async () => {
    fake.adoptable = [{ path: "/repo/wt-a", branch: "a" }]
    await runCli("adopt", "/zzz/*")
    expect(logText()).toContain("no worktrees match glob")
  })

  test("glob + --yes adopts exactly the matches", async () => {
    fake.adoptable = [
      { path: "/repo/wt-a", branch: "a" },
      { path: "/repo/other", branch: "b" },
    ]
    await runCli("adopt", "/repo/wt-*", "--yes")
    expect(fake.adoptWorktree).toHaveBeenCalledTimes(1)
    expect(fake.adoptWorktree).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: "/repo/wt-a" }))
    expect(logText()).toContain("done — adopted 1 worktree(s)")
  })

  test("an unexpected argument is a usage error, not silently ignored", async () => {
    await runCli("adopt", "glob-a", "glob-b")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain('unexpected argument "glob-b"')
  })

  test("--repo without a value is a usage error", async () => {
    await runCli("adopt", "--repo")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain("--repo requires a value")
  })

  test("--vendor without a value is a usage error", async () => {
    await runCli("adopt", "--vendor")
    expect(exitSpy).toHaveBeenCalledWith(2)
    expect(stderrText()).toContain("--vendor requires a value")
  })

  test("--help prints usage without scanning anything", async () => {
    await runCli("adopt", "--help")
    expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join("")).toContain("Usage: kobe adopt")
    expect(fake.adoptWorktree).not.toHaveBeenCalled()
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
