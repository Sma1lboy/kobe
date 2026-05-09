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
  TaskNotFoundError,
} from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { worktreePathFor } from "../../src/orchestrator/worktree/paths.ts"
import type { AIEngine, EngineEvent, SessionHandle, SpawnOpts } from "../../src/types/engine.ts"
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
// createTask
// ----------------------------------------------------------------------

describe("Orchestrator.createTask", () => {
  test("persists a backlog task and creates the worktree on disk", async () => {
    const { orch, store } = await buildOrchestrator()
    const task = await orch.createTask({ repo, title: "demo task", prompt: "" })
    expect(task.title).toBe("demo task")
    expect(task.status).toBe("backlog")
    expect(task.sessionId).toBeNull()
    // worktree path matches the canonical layout
    expect(task.worktreePath).toBe(worktreePathFor(repo, task.id))
    // and exists on disk with the fixture's README copied in
    expect(fs.existsSync(task.worktreePath)).toBe(true)
    expect(fs.existsSync(path.join(task.worktreePath, "README.md"))).toBe(true)
    // and is on a kobe/-prefixed branch
    expect(task.branch.startsWith("kobe/")).toBe(true)
    // store sees it too
    expect(store.list()).toHaveLength(1)
  })

  test("uses an explicit branch override when provided", async () => {
    const { orch } = await buildOrchestrator()
    const task = await orch.createTask({
      repo,
      title: "override",
      prompt: "",
      branch: "feature/explicit",
    })
    expect(task.branch).toBe("feature/explicit")
  })

  test("rolls back the placeholder task when worktree creation fails", async () => {
    const { orch, store } = await buildOrchestrator()
    // Pass a non-repo path so git rejects the worktree creation.
    const bogusRepo = path.join(tmpRoot, "no-such-repo")
    fs.mkdirSync(bogusRepo, { recursive: true })
    await expect(orch.createTask({ repo: bogusRepo, title: "bad", prompt: "" })).rejects.toThrow()
    // The placeholder should be in `canceled` status (we don't hard-delete).
    const all = store.list()
    if (all.length > 0) {
      expect(all[0]?.status).toBe("canceled")
    }
  })

  test("tasksSignal updates after createTask", async () => {
    const { orch } = await buildOrchestrator()
    const sig = orch.tasksSignal()
    expect(sig().length).toBe(0)
    const t = await orch.createTask({ repo, title: "sig", prompt: "" })
    expect(sig().length).toBe(1)
    expect(sig()[0]?.id).toBe(t.id)
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
    const seen: EngineEvent[] = []
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
    expect(opts?.env?.KOBE_RESUME_CWD).toBe(t.worktreePath)
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
// subscribeEvents — multi-subscriber + unsubscribe
// ----------------------------------------------------------------------

describe("Orchestrator.subscribeEvents", () => {
  test("delivers events to multiple subscribers; unsubscribe stops delivery", async () => {
    const fake = new FakeAIEngine()
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "sub", prompt: "" })

    const a: EngineEvent[] = []
    const b: EngineEvent[] = []
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
      async stop() {},
    }
    const { orch } = await buildOrchestrator(stub)
    const t = await orch.createTask({ repo, title: "shape", prompt: "" })
    await orch.runTask(t.id, "first")
    await orch._waitForPumpsIdle()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(t.worktreePath)
    expect(calls[0]?.prompt).toBe("first")
  })
})
