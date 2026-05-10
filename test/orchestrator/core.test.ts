/**
 * Unit tests for `Orchestrator` (Wave 2 Stream E).
 *
 * Why these tests matter:
 *   - The orchestrator is the only thing that wires the engine, the
 *     worktree manager, and the task index together. A regression here
 *     breaks the entire end-to-end flow even if all three sub-modules
 *     pass their own unit tests.
 *   - The status state machine is the user-visible contract of the
 *     sidebar: backlog → in_progress → done is the canonical happy
 *     path. Coverage here must include every transition the UI
 *     depends on.
 *   - The resume cwd back-channel is the load-bearing detail from
 *     Wave 1's deviation list: if the orchestrator forgets
 *     `KOBE_RESUME_CWD`, Claude Code resumes in the wrong cwd and
 *     blows away the worktree assumption. We assert it explicitly.
 *
 * Test isolation:
 *   - `homeDir` for the task index is a fresh tmpdir per test.
 *   - The repo is built from `repo-init.sh` so we test against real
 *     git, not a mock — the worktree manager has its own dedicated
 *     suite for fine-grained git assertions.
 *   - Every test does `await orch._waitForPumpsIdle()` before
 *     asserting on terminal status to flush the background pump.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  CONCURRENCY_CAP,
  ConcurrencyCapError,
  IllegalTransitionError,
  Orchestrator,
  TITLE_CHAR_CAP,
  TaskNotFoundError,
  deriveTitleFromPrompt,
  detectUserInputFromEngineEvent,
  renderUserInputResponsePrompt,
} from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { worktreePathFor } from "../../src/orchestrator/worktree/paths.ts"
import type { AIEngine, EngineEvent, OrchestratorEvent, SessionHandle, SpawnOpts } from "../../src/types/engine.ts"
import { FakeAIEngine } from "../behavior/fake-engine.ts"

const REPO_INIT = path.resolve(__dirname, "../behavior/fixtures/repo-init.sh")

let tmpRoot: string
let homeDir: string
let repo: string

async function buildOrchestrator(engine?: AIEngine): Promise<{
  orch: Orchestrator
  store: TaskIndexStore
  engine: AIEngine
}> {
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const worktrees = new GitWorktreeManager()
  const eng = engine ?? new FakeAIEngine()
  const orch = new Orchestrator({ engine: eng, store, worktrees })
  return { orch, store, engine: eng }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-orch-"))
  homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  repo = path.join(tmpRoot, "repo")
  const result = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}\n${result.stdout}`)
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// ----------------------------------------------------------------------
// deriveTitleFromPrompt — pure helper; lives next to createTask because
// the new contract is "no explicit title — derive from prompt".
// ----------------------------------------------------------------------

describe("deriveTitleFromPrompt", () => {
  test("returns empty string for empty / whitespace-only input", () => {
    expect(deriveTitleFromPrompt("")).toBe("")
    expect(deriveTitleFromPrompt("   ")).toBe("")
    expect(deriveTitleFromPrompt("\n\n  \t")).toBe("")
  })

  test("collapses internal whitespace to single spaces and trims", () => {
    expect(deriveTitleFromPrompt("  fix\n\nlogin   redirect  ")).toBe("fix login redirect")
  })

  test("returns the prompt verbatim when within the cap", () => {
    const small = "x".repeat(TITLE_CHAR_CAP)
    expect(deriveTitleFromPrompt(small)).toBe(small)
  })

  test("truncates and appends ellipsis when the collapsed prompt exceeds the cap", () => {
    const big = "x".repeat(TITLE_CHAR_CAP + 10)
    const out = deriveTitleFromPrompt(big)
    expect(out.length).toBe(TITLE_CHAR_CAP + 1)
    expect(out.endsWith("…")).toBe(true)
  })
})

// ----------------------------------------------------------------------
// createTask
// ----------------------------------------------------------------------

describe("Orchestrator.createTask", () => {
  test("persists a backlog task; runTask is what allocates the worktree (lazy)", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const task = await orch.createTask({ repo, title: "demo task", prompt: "" })
    expect(task.title).toBe("demo task")
    expect(task.status).toBe("backlog")
    expect(task.sessionId).toBeNull()
    // Lazy: createTask leaves worktreePath + branch empty.
    expect(task.worktreePath).toBe("")
    expect(task.branch).toBe("")
    expect(store.list()).toHaveLength(1)

    // First runTask allocates the worktree on disk.
    await orch.runTask(task.id, "first")
    fake.finish("fake-1")
    await orch._waitForPumpsIdle()
    const updated = store.get(task.id)!
    expect(updated.worktreePath).toBe(worktreePathFor(repo, task.id))
    expect(fs.existsSync(updated.worktreePath)).toBe(true)
    expect(fs.existsSync(path.join(updated.worktreePath, "README.md"))).toBe(true)
    expect(updated.branch.startsWith("kobe/")).toBe(true)
  })

  test("uses an explicit branch override when provided (allocated lazily)", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const task = await orch.createTask({
      repo,
      title: "override",
      prompt: "",
      branch: "feature/explicit",
    })
    expect(task.branch).toBe("") // lazy — populated by runTask
    await orch.runTask(task.id, "first")
    fake.finish("fake-1")
    await orch._waitForPumpsIdle()
    expect(store.get(task.id)?.branch).toBe("feature/explicit")
  })

  test("runTask surfaces worktree creation failures without crashing", async () => {
    const { orch, store } = await buildOrchestrator()
    // Pass a non-repo path so git rejects the worktree creation.
    const bogusRepo = path.join(tmpRoot, "no-such-repo")
    fs.mkdirSync(bogusRepo, { recursive: true })
    const t = await orch.createTask({ repo: bogusRepo, title: "bad", prompt: "" })
    // createTask itself succeeds (lazy); the failure surfaces from runTask.
    expect(store.get(t.id)?.status).toBe("backlog")
    await expect(orch.runTask(t.id, "go")).rejects.toThrow()
    // Task stays in backlog with empty worktreePath; the user can rename
    // / cancel / retry without an orphan on disk.
    const after = store.get(t.id)!
    expect(after.status).toBe("backlog")
    expect(after.worktreePath).toBe("")
  })

  test("derives title from prompt when no explicit title is provided", async () => {
    const { orch } = await buildOrchestrator()
    const task = await orch.createTask({ repo, prompt: "fix the login redirect bug" })
    expect(task.title).toBe("fix the login redirect bug")
  })

  test("falls back to PLACEHOLDER_TASK_TITLE when both title and prompt are empty", async () => {
    // The dialog now creates tasks with no first prompt — runTask
    // back-fills the title from the user's first composer submit. The
    // pre-submit interim sits at the placeholder.
    const { orch } = await buildOrchestrator()
    const t = await orch.createTask({ repo, prompt: "" })
    expect(t.title).toBe("(new task)")
  })

  test("tasksSignal updates after createTask", async () => {
    const { orch } = await buildOrchestrator()
    const sig = orch.tasksSignal()
    expect(sig().length).toBe(0)
    const t = await orch.createTask({ repo, title: "sig", prompt: "" })
    expect(sig().length).toBe(1)
    expect(sig()[0]?.id).toBe(t.id)
  })

  test("tasksSignal updates reactively from any store mutation, not just orchestrator API", async () => {
    // Regression test for the H2 bug: the sidebar's `Task[]` accessor
    // must wake up whenever the store mutates — including paths that
    // bypass the orchestrator's mutation methods (e.g. the pump's
    // `finally` block calling `store.update` directly). Before the
    // fix, the orchestrator manually called `refreshSignal()` after
    // every mutation; if any path forgot, the sidebar drifted.
    //
    // This test asserts the listener-based wiring: a direct call on
    // the store (not on the orchestrator) MUST trigger a signal
    // update. This is the property the brief's behavior test relies
    // on at the TUI level.
    const { orch, store } = await buildOrchestrator()
    const sig = orch.tasksSignal()
    expect(sig().length).toBe(0)

    const t = await orch.createTask({ repo, title: "reactivity", prompt: "" })
    expect(sig()[0]?.status).toBe("backlog")

    // Bypass the orchestrator and mutate the store directly.
    await store.update(t.id, { status: "done" })
    expect(sig()[0]?.status).toBe("done")
    expect(sig().length).toBe(1)

    // archive() also flows through the listener bus.
    await store.archive(t.id, "canceled")
    expect(sig()[0]?.status).toBe("canceled")
  })
})

// ----------------------------------------------------------------------
// runTask + status transitions
// ----------------------------------------------------------------------

describe("Orchestrator.runTask", () => {
  test("backlog → in_progress on first runTask, sessionId persisted", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "run me", prompt: "" })
    expect(t.sessionId).toBeNull()

    await orch.runTask(t.id, "hello")
    const updated = store.get(t.id)!
    expect(updated.status).toBe("in_progress")
    expect(updated.sessionId).toBe("fake-1")

    // Cleanly finish the engine so subsequent tests don't hang the pump.
    fake.finish("fake-1")
    await orch._waitForPumpsIdle()
  })

  test("scripted assistant.delta + done → status transitions to done", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "happy", prompt: "" })

    // Capture events flowing to the subscriber.
    const seen: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => seen.push(ev))

    // Pre-script future events. spawn() will allocate "fake-1" so we
    // script under that id. (Order: createTask → script → runTask.)
    fake.script("fake-1", [
      { type: "assistant.delta", text: "hi " },
      { type: "assistant.delta", text: "there" },
      { type: "done" },
    ])

    await orch.runTask(t.id, "hello")
    await orch._waitForPumpsIdle()

    const types = seen.map((e) => e.type)
    expect(types).toContain("assistant.delta")
    expect(types).toContain("done")

    expect(store.get(t.id)?.status).toBe("done")
  })

  test("error event transitions task to error status", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "boom", prompt: "" })
    fake.script("fake-1", [{ type: "error", message: "kaboom" }])

    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()

    expect(store.get(t.id)?.status).toBe("error")
  })

  test("resume() includes KOBE_RESUME_CWD = task.worktreePath in opts.env", async () => {
    // Spy on a real FakeAIEngine.resume to verify the env channel.
    const fake = new FakeAIEngine()
    const resumeSpy = vi.spyOn(fake, "resume")
    const { orch } = await buildOrchestrator(fake)

    const t = await orch.createTask({ repo, title: "resume me", prompt: "" })

    // First run spawns; finish so we can resume cleanly.
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "first")
    await orch._waitForPumpsIdle()

    // Second run should resume — sessionId is set on the task now.
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "second")
    await orch._waitForPumpsIdle()

    expect(resumeSpy).toHaveBeenCalledOnce()
    const args = resumeSpy.mock.calls[0]!
    const [sessionId, prompt, opts] = args as [string, string, SpawnOpts | undefined]
    expect(sessionId).toBe("fake-1")
    expect(prompt).toBe("second")
    // worktreePath was lazily allocated during the first runTask; refetch.
    expect(opts?.env?.KOBE_RESUME_CWD).toBe(orch.getTask(t.id)?.worktreePath)
  })

  test("rejects with TaskNotFoundError for unknown id", async () => {
    const { orch } = await buildOrchestrator()
    await expect(orch.runTask("does-not-exist")).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  test("rejects canceled tasks", async () => {
    const { orch } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "x", prompt: "" })
    await orch.archiveTask(t.id, "canceled")
    await expect(orch.runTask(t.id, "no")).rejects.toBeInstanceOf(IllegalTransitionError)
  })

  test("enforces the concurrency cap and rejects with ConcurrencyCapError", async () => {
    // Use a non-finishing fake engine: each spawned session stays
    // open until we explicitly finish it. Pre-script none, don't
    // close — they accumulate as "in_progress".
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)

    const tasks = []
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      const t = await orch.createTask({ repo, title: `t${i}`, prompt: "" })
      await orch.runTask(t.id, "go")
      tasks.push(t)
    }
    // CONCURRENCY_CAP is now consumed. The next one must reject.
    const overflow = await orch.createTask({
      repo,
      title: "overflow",
      prompt: "",
    })
    await expect(orch.runTask(overflow.id, "go")).rejects.toBeInstanceOf(ConcurrencyCapError)

    // Cleanup: drain in-flight pumps so the test process exits cleanly.
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      fake.finish(`fake-${i + 1}`)
    }
    await orch._waitForPumpsIdle()
  })
})

// ----------------------------------------------------------------------
// pauseTask
// ----------------------------------------------------------------------

describe("Orchestrator.pauseTask", () => {
  test("in_progress → backlog and stops the engine handle", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)

    const t = await orch.createTask({ repo, title: "pause", prompt: "" })
    await orch.runTask(t.id, "go")
    expect(store.get(t.id)?.status).toBe("in_progress")

    await orch.pauseTask(t.id)
    expect(store.get(t.id)?.status).toBe("backlog")
    expect(stopSpy).toHaveBeenCalledOnce()
    await orch._waitForPumpsIdle()
  })

  test("rejects when the task is not in_progress", async () => {
    const { orch } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "p", prompt: "" })
    // backlog → backlog via pauseTask is illegal
    await expect(orch.pauseTask(t.id)).rejects.toBeInstanceOf(IllegalTransitionError)
  })
})

// ----------------------------------------------------------------------
// archiveTask
// ----------------------------------------------------------------------

describe("Orchestrator.archiveTask", () => {
  test("done from any state, kills engine if running", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "arch", prompt: "" })
    await orch.runTask(t.id, "go")
    await orch.archiveTask(t.id, "done")
    expect(store.get(t.id)?.status).toBe("done")
    expect(stopSpy).toHaveBeenCalledOnce()
    await orch._waitForPumpsIdle()
  })

  test("canceled from any state", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "x", prompt: "" })
    await orch.archiveTask(t.id, "canceled")
    expect(store.get(t.id)?.status).toBe("canceled")
  })

  test("rejects illegal target status", async () => {
    const { orch } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "x", prompt: "" })
    // @ts-expect-error: testing runtime guard
    await expect(orch.archiveTask(t.id, "in_progress")).rejects.toBeInstanceOf(IllegalTransitionError)
  })
})

// ----------------------------------------------------------------------
// deleteTask — sidebar `d` flow
// ----------------------------------------------------------------------

describe("Orchestrator.deleteTask", () => {
  test("removes the task entry, the worktree, and the chat history", async () => {
    const fake = new FakeAIEngine()
    const deleteHistorySpy = vi.spyOn(fake, "deleteHistory")
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "delete-backlog", prompt: "" })
    // Trigger lazy worktree allocation so there's something to delete.
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()
    const wt = orch.getTask(t.id)!.worktreePath
    expect(fs.existsSync(wt)).toBe(true)
    await store.update(t.id, { sessionId: "sess-1" })

    await orch.deleteTask(t.id)

    expect(store.get(t.id)).toBeUndefined()
    expect(fs.existsSync(wt)).toBe(false)
    expect(deleteHistorySpy).toHaveBeenCalledWith("sess-1")
  })

  test("pauses an in_progress task before removing its worktree", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "delete-running", prompt: "" })
    await orch.runTask(t.id, "go")
    expect(store.get(t.id)?.status).toBe("in_progress")
    const wt = orch.getTask(t.id)!.worktreePath

    await orch.deleteTask(t.id)
    await orch._waitForPumpsIdle()

    expect(stopSpy).toHaveBeenCalled()
    expect(store.get(t.id)).toBeUndefined()
    expect(fs.existsSync(wt)).toBe(false)
  })

  test("force-removes a dirty worktree (the user confirmed)", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "delete-dirty", prompt: "" })
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()
    const wt = orch.getTask(t.id)!.worktreePath
    fs.writeFileSync(path.join(wt, "wip.txt"), "wip\n")

    await orch.deleteTask(t.id)

    expect(fs.existsSync(wt)).toBe(false)
    expect(store.get(t.id)).toBeUndefined()
  })

  test("is a no-op for unknown ids (defensive)", async () => {
    const { orch, store } = await buildOrchestrator()
    // No throw, no mutation — the UI may emit the request with a
    // stale id after a fast cursor + key chord race.
    await expect(orch.deleteTask("does-not-exist")).resolves.toBeUndefined()
    expect(store.list()).toHaveLength(0)
  })

  test("surfaces engine stop failures as warnings without throwing past the caller", async () => {
    // A degenerate engine whose stop() throws — simulates a
    // half-stuck child process. deleteTask must still archive and
    // not bubble up the engine-side failure to the UI.
    const stub: AIEngine = {
      async spawn(cwd) {
        return { sessionId: "sess-1", cwd } satisfies SessionHandle
      },
      async resume() {
        throw new Error("not used")
      },
      stream() {
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            // Never yield until stop() is called externally.
            await new Promise<void>(() => {})
            yield { type: "done" } as EngineEvent
          },
        }
      },
      async readHistory() {
        return []
      },
      async deleteHistory() {},
      async stop() {
        throw new Error("simulated stuck engine")
      },
    }
    const { orch, store } = await buildOrchestrator(stub)
    const t = await orch.createTask({ repo, title: "delete-stuck", prompt: "" })
    await orch.runTask(t.id, "go")

    // Suppress the expected console.error from the safety net so the
    // test output stays clean.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(orch.deleteTask(t.id)).resolves.toBeUndefined()
    errSpy.mockRestore()

    expect(store.get(t.id)).toBeUndefined()
    expect(fs.existsSync(t.worktreePath)).toBe(false)
  })
})

// ----------------------------------------------------------------------
// setTitle — sidebar `r` rename flow
// ----------------------------------------------------------------------

describe("Orchestrator.setTitle", () => {
  test("persists a new trimmed title", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "old", prompt: "" })
    await orch.setTitle(t.id, "  new title  ")
    expect(store.get(t.id)?.title).toBe("new title")
  })

  test("rejects empty title", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "keep", prompt: "" })
    await expect(orch.setTitle(t.id, "")).rejects.toThrow(/title/i)
    // Title unchanged after rejection.
    expect(store.get(t.id)?.title).toBe("keep")
  })

  test("rejects whitespace-only title", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "keep", prompt: "" })
    await expect(orch.setTitle(t.id, "   \t\n  ")).rejects.toThrow(/title/i)
    expect(store.get(t.id)?.title).toBe("keep")
  })

  test("same-as-current is a no-op (no store write)", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "same", prompt: "" })
    const updateSpy = vi.spyOn(store, "update")
    await orch.setTitle(t.id, "same")
    expect(updateSpy).not.toHaveBeenCalled()
    // Pre/post-trim equality also a no-op.
    await orch.setTitle(t.id, "  same  ")
    expect(updateSpy).not.toHaveBeenCalled()
    expect(store.get(t.id)?.title).toBe("same")
  })

  test("throws TaskNotFoundError for unknown id", async () => {
    const { orch } = await buildOrchestrator()
    await expect(orch.setTitle("does-not-exist", "x")).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  test("tasksSignal reflects the new title after setTitle", async () => {
    // Regression guard: setTitle must flow through the listener bus so
    // the sidebar redraws — same property archive/permission-mode/model
    // depend on. If the implementation stopped going through
    // store.update (e.g. mutated `task.title` in place), the sidebar
    // would silently drift.
    const { orch } = await buildOrchestrator()
    const sig = orch.tasksSignal()
    const t = await orch.createTask({ repo, title: "first", prompt: "" })
    expect(sig().find((x) => x.id === t.id)?.title).toBe("first")
    await orch.setTitle(t.id, "second")
    expect(sig().find((x) => x.id === t.id)?.title).toBe("second")
  })
})

// ----------------------------------------------------------------------
// createTask — baseRef forwarding (new-task dialog "from branch" field)
// ----------------------------------------------------------------------

describe("Orchestrator.createTask baseRef plumbing", () => {
  test("forwards baseRef to the worktree manager so the branch is rooted at it", async () => {
    // Make a non-default branch in the fixture repo so we can root
    // the new task at it. The base branch's HEAD commit must be
    // distinct from `main`'s so we can assert ancestry.
    spawnSync("git", ["checkout", "-b", "release-base"], { cwd: repo })
    fs.writeFileSync(path.join(repo, "BASE.md"), "release base file\n")
    spawnSync("git", ["add", "BASE.md"], { cwd: repo })
    spawnSync("git", ["commit", "-m", "release base commit"], { cwd: repo })
    // Capture the release-base SHA for ancestry assertion.
    const releaseSha = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim()
    // Switch back to main so the worktree creation actually has to
    // honor `baseRef` instead of just inheriting current HEAD.
    spawnSync("git", ["checkout", "main"], { cwd: repo })

    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({
      repo,
      title: "from-base",
      prompt: "",
      baseRef: "release-base",
    })
    // Lazy worktree: trigger allocation via runTask before asserting.
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()
    const wt = orch.getTask(t.id)!.worktreePath

    // The new worktree's HEAD must descend from the release-base SHA
    // (or be it). `git merge-base --is-ancestor` exits 0 when yes.
    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", releaseSha, "HEAD"], {
      cwd: wt,
    })
    expect(ancestry.status).toBe(0)
    // And the BASE.md file from the release branch must be present.
    expect(fs.existsSync(path.join(wt, "BASE.md"))).toBe(true)
  })
})

// ----------------------------------------------------------------------
// subscribeEvents — multi-subscriber + unsubscribe
// ----------------------------------------------------------------------

describe("Orchestrator.subscribeEvents", () => {
  test("delivers events to multiple subscribers; unsubscribe stops delivery", async () => {
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "sub", prompt: "" })

    const a: OrchestratorEvent[] = []
    const b: OrchestratorEvent[] = []
    const unsubA = orch.subscribeEvents(t.id, (ev) => a.push(ev))
    orch.subscribeEvents(t.id, (ev) => b.push(ev))

    fake.script("fake-1", [{ type: "assistant.delta", text: "x" }])
    await orch.runTask(t.id, "go")
    // Drain a tick so pump pushes events.
    await new Promise((r) => setTimeout(r, 50))

    expect(a.find((e) => e.type === "assistant.delta")).toBeDefined()
    expect(b.find((e) => e.type === "assistant.delta")).toBeDefined()

    unsubA()
    fake.script("fake-1", [{ type: "done" }])
    await orch._waitForPumpsIdle()

    // After unsubA, only b should see the trailing done.
    expect(a.some((e) => e.type === "done")).toBe(false)
    expect(b.some((e) => e.type === "done")).toBe(true)
  })
})

// ----------------------------------------------------------------------
// SessionHandle plumbing — spy on engine.spawn arguments
// ----------------------------------------------------------------------

describe("Orchestrator engine call shape", () => {
  test("spawn() receives the task's worktreePath as cwd", async () => {
    const calls: { cwd: string; prompt: string }[] = []
    const stub: AIEngine = {
      async spawn(cwd, prompt) {
        calls.push({ cwd, prompt })
        return { sessionId: "sess-1", cwd } satisfies SessionHandle
      },
      async resume() {
        throw new Error("not used here")
      },
      stream() {
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            yield { type: "done" } as EngineEvent
          },
        }
      },
      async readHistory() {
        return []
      },
      async deleteHistory() {},
      async stop() {},
    }
    const { orch } = await buildOrchestrator(stub)
    const t = await orch.createTask({ repo, title: "shape", prompt: "" })
    await orch.runTask(t.id, "first")
    await orch._waitForPumpsIdle()

    expect(calls).toHaveLength(1)
    // worktreePath was lazily allocated during runTask; refetch.
    expect(calls[0]?.cwd).toBe(orch.getTask(t.id)?.worktreePath)
    expect(calls[0]?.prompt).toBe("first")
  })
})

// ----------------------------------------------------------------------
// User-input request detection + response (ExitPlanMode)
// ----------------------------------------------------------------------

describe("detectUserInputFromEngineEvent", () => {
  test("returns null for unrelated events", () => {
    expect(detectUserInputFromEngineEvent({ type: "assistant.delta", text: "hi" })).toBeNull()
    expect(detectUserInputFromEngineEvent({ type: "tool.start", name: "Read", input: { path: "/x" } })).toBeNull()
    expect(detectUserInputFromEngineEvent({ type: "tool.result", name: "ExitPlanMode", output: {} })).toBeNull()
    expect(detectUserInputFromEngineEvent({ type: "done" })).toBeNull()
  })

  test("extracts plan + filePath from ExitPlanMode tool.start", () => {
    const out = detectUserInputFromEngineEvent({
      type: "tool.start",
      name: "ExitPlanMode",
      input: { plan: "## Step 1\n- do thing", filePath: "/tmp/plan.md" },
    })
    expect(out).toEqual({ kind: "approve_plan", plan: "## Step 1\n- do thing", filePath: "/tmp/plan.md" })
  })

  test("also matches ExitPlanModeV2Tool, missing filePath becomes null", () => {
    const out = detectUserInputFromEngineEvent({
      type: "tool.start",
      name: "ExitPlanModeV2Tool",
      input: { plan: "p" },
    })
    expect(out).toEqual({ kind: "approve_plan", plan: "p", filePath: null })
  })

  test("non-object input returns null", () => {
    expect(detectUserInputFromEngineEvent({ type: "tool.start", name: "ExitPlanMode", input: "oops" })).toBeNull()
  })

  test("AskUserQuestion → typed payload with normalized question shape", () => {
    const out = detectUserInputFromEngineEvent({
      type: "tool.start",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which library?",
            header: "Library",
            multiSelect: false,
            options: [
              { label: "date-fns", description: "Functional, tree-shakable" },
              { label: "luxon", description: "Class-based, immutable" },
            ],
          },
        ],
      },
    })
    expect(out).toEqual({
      kind: "ask_question",
      questions: [
        {
          question: "Which library?",
          header: "Library",
          multiSelect: false,
          options: [
            { label: "date-fns", description: "Functional, tree-shakable" },
            { label: "luxon", description: "Class-based, immutable" },
          ],
        },
      ],
    })
  })

  test("AskUserQuestion defaults missing fields (multiSelect → false, header → '', desc → '')", () => {
    const out = detectUserInputFromEngineEvent({
      type: "tool.start",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "?",
            options: [{ label: "A" }, { label: "B" }],
          },
        ],
      },
    })
    expect(out).toEqual({
      kind: "ask_question",
      questions: [
        {
          question: "?",
          header: "",
          multiSelect: false,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    })
  })

  test("AskUserQuestion with no usable question returns null", () => {
    expect(
      detectUserInputFromEngineEvent({
        type: "tool.start",
        name: "AskUserQuestion",
        input: { questions: [{ question: "" }, { options: [] }] },
      }),
    ).toBeNull()
    expect(
      detectUserInputFromEngineEvent({ type: "tool.start", name: "AskUserQuestion", input: { questions: [] } }),
    ).toBeNull()
  })
})

describe("renderUserInputResponsePrompt", () => {
  test("approve → 'Plan approved...' string", () => {
    const out = renderUserInputResponsePrompt(
      { kind: "approve_plan", plan: "p", filePath: null },
      { kind: "approve_plan", approve: true },
    )
    expect(out).toContain("approved")
    expect(out.toLowerCase()).toContain("proceed")
  })

  test("reject → 'Plan rejected...' string", () => {
    const out = renderUserInputResponsePrompt(
      { kind: "approve_plan", plan: "p", filePath: null },
      { kind: "approve_plan", approve: false },
    )
    expect(out).toContain("rejected")
  })

  test("ask_question → bullet list of questions with answers, ends with 'Please continue.'", () => {
    const out = renderUserInputResponsePrompt(
      {
        kind: "ask_question",
        questions: [
          {
            question: "Which library?",
            header: "Lib",
            multiSelect: false,
            options: [
              { label: "date-fns", description: "" },
              { label: "luxon", description: "" },
            ],
          },
          {
            question: "Which features?",
            header: "Feat",
            multiSelect: true,
            options: [
              { label: "TZ", description: "" },
              { label: "i18n", description: "" },
            ],
          },
        ],
      },
      {
        kind: "ask_question",
        answers: { "Which library?": "date-fns", "Which features?": "TZ, i18n" },
      },
    )
    expect(out).toContain("Which library? → date-fns")
    expect(out).toContain("Which features? → TZ, i18n")
    expect(out).toMatch(/Please continue\.$/)
  })

  test("ask_question with missing answer falls back to '(no answer)'", () => {
    const out = renderUserInputResponsePrompt(
      {
        kind: "ask_question",
        questions: [
          {
            question: "Skipped?",
            header: "X",
            multiSelect: false,
            options: [{ label: "A", description: "" }],
          },
        ],
      },
      { kind: "ask_question", answers: {} },
    )
    expect(out).toContain("Skipped? → (no answer)")
  })
})

describe("Orchestrator.respondToInput", () => {
  test("emits user_input.request when ExitPlanMode tool fires, then resolved + user.inject on approve", async () => {
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "plan-flow", prompt: "" })

    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev))

    fake.script("fake-1", [
      { type: "tool.start", name: "ExitPlanMode", input: { plan: "# Plan\n- step", filePath: "/tmp/p.md" } },
      { type: "done" },
    ])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()

    const req = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user_input.request" }> => e.type === "user_input.request",
    )
    expect(req).toBeDefined()
    expect(req?.payload).toEqual({ kind: "approve_plan", plan: "# Plan\n- step", filePath: "/tmp/p.md" })

    // Now answer it. Script the resume's response so runTask completes.
    fake.script("fake-1", [{ type: "done" }])
    await orch.respondToInput(t.id, req?.requestId ?? "missing", { kind: "approve_plan", approve: true })
    await orch._waitForPumpsIdle()

    const resolved = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user_input.resolved" }> => e.type === "user_input.resolved",
    )
    expect(resolved).toBeDefined()
    expect(resolved?.requestId).toBe(req?.requestId)
    expect(resolved?.response).toEqual({ kind: "approve_plan", approve: true })

    const inject = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user.inject" }> => e.type === "user.inject",
    )
    expect(inject?.text.toLowerCase()).toContain("approved")
  })

  test("respondToInput is a no-op for unknown requestId (e.g. double-click race)", async () => {
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "noop", prompt: "" })

    // No request was ever emitted; calling respondToInput should not throw
    // and should not emit anything on the bus.
    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev))

    await orch.respondToInput(t.id, "never-saw-this", { kind: "approve_plan", approve: true })
    expect(events).toEqual([])
  })

  test("AskUserQuestion end-to-end: tool.start → request → respond → resolved + user.inject", async () => {
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "q-flow", prompt: "" })

    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev))

    fake.script("fake-1", [
      {
        type: "tool.start",
        name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which library?",
              header: "Lib",
              options: [{ label: "date-fns" }, { label: "luxon" }],
            },
          ],
        },
      },
      { type: "done" },
    ])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()

    const req = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user_input.request" }> => e.type === "user_input.request",
    )
    expect(req).toBeDefined()
    expect(req?.payload.kind).toBe("ask_question")

    fake.script("fake-1", [{ type: "done" }])
    await orch.respondToInput(t.id, req?.requestId ?? "missing", {
      kind: "ask_question",
      answers: { "Which library?": "date-fns" },
    })
    await orch._waitForPumpsIdle()

    const resolved = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user_input.resolved" }> => e.type === "user_input.resolved",
    )
    expect(resolved?.response).toEqual({ kind: "ask_question", answers: { "Which library?": "date-fns" } })

    const inject = events.find(
      (e): e is Extract<OrchestratorEvent, { type: "user.inject" }> => e.type === "user.inject",
    )
    expect(inject?.text).toContain("Which library? → date-fns")
  })
})
