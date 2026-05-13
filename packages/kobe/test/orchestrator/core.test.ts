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
import { claudeCapabilities, claudeIdentity } from "../../src/engine/claude-code-local/capabilities.ts"
import { codexCapabilities, codexIdentity } from "../../src/engine/codex-local/capabilities.ts"
import {
  CONCURRENCY_CAP,
  CannotDeleteMainTaskError,
  ConcurrencyCapError,
  IllegalTransitionError,
  Orchestrator,
  TITLE_CHAR_CAP,
  TaskNotFoundError,
  deriveTitleFromPrompt,
} from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { MetadataSuggester } from "../../src/orchestrator/metadata-suggester.ts"
import { detectUserInputFromEngineEvent, renderUserInputResponsePrompt } from "../../src/orchestrator/user-input.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"
import { worktreePathFor } from "../../src/orchestrator/worktree/paths.ts"
import { SlugAllocator } from "../../src/orchestrator/worktree/slug-allocator.ts"
import type {
  AIEngine,
  EngineCapabilities,
  EngineEvent,
  EngineHistory,
  EngineIdentity,
  OrchestratorEvent,
  SessionHandle,
  SpawnOpts,
} from "../../src/types/engine.ts"
import { worktreeSlug } from "../../src/types/task.ts"
import type { VendorId } from "../../src/types/vendor.ts"
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

class HistoryEngine implements AIEngine {
  readonly identity: EngineIdentity
  readonly capabilities: EngineCapabilities
  readonly spawns: Array<{ cwd: string; prompt: string; model?: string; modelEffort?: string }> = []
  readonly streamCalls: string[] = []
  private readonly scripts = new Map<string, readonly EngineEvent[]>()
  private next = 1

  constructor(private readonly vendor: VendorId) {
    this.identity = vendor === "codex" ? codexIdentity : claudeIdentity
    this.capabilities = vendor === "codex" ? codexCapabilities : claudeCapabilities
  }

  async spawn(cwd: string, prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    this.spawns.push({ cwd, prompt, model: opts?.model, modelEffort: opts?.modelEffort })
    return { sessionId: `${this.vendor}-${this.next++}`, cwd }
  }

  script(sessionId: string, events: readonly EngineEvent[]): void {
    this.scripts.set(sessionId, events)
  }

  async resume(sessionId: string, _prompt: string, opts?: SpawnOpts): Promise<SessionHandle> {
    return { sessionId, cwd: opts?.cwd ?? "/" }
  }

  stream(h: SessionHandle): AsyncIterable<EngineEvent> {
    this.streamCalls.push(h.sessionId)
    const events = this.scripts.get(h.sessionId) ?? ([{ type: "done" }] as const)
    return (async function* () {
      for (const ev of events) yield ev
    })()
  }

  async readHistory(sessionId: string): Promise<EngineHistory> {
    return {
      messages: [
        {
          role: "assistant",
          blocks: [{ type: "text", text: `${this.vendor} history for ${sessionId}` }],
          timestamp: "2026-05-12T00:00:00.000Z",
          sessionId,
        },
      ],
    }
  }

  async deleteHistory(_sessionId: string): Promise<void> {}

  async listSessions(_cwd: string) {
    return []
  }

  async stop(_h: SessionHandle): Promise<void> {}
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
    // KOB-65: dir name is now an allocated animal slug, not the ULID.
    const slug = worktreeSlug(updated)
    expect(slug).not.toBe("")
    expect(updated.worktreePath).toBe(worktreePathFor(repo, slug))
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

  test("concurrent first-prompt runTasks both reject when allocation fails", async () => {
    // Regression for an ensureWorktree latch bug: when the in-flight
    // allocator failed, the runner-up used to `.catch(() => {})` the
    // rejection and return a task with `worktreePath: ""`, then runTask
    // would proceed to spawn the engine with an empty cwd. Both callers
    // must reject with the same surfaced error.
    const { orch, store } = await buildOrchestrator()
    const bogusRepo = path.join(tmpRoot, "no-such-repo-concurrent")
    fs.mkdirSync(bogusRepo, { recursive: true })
    const t = await orch.createTask({ repo: bogusRepo, title: "bad-concurrent", prompt: "" })
    const [a, b] = await Promise.allSettled([orch.runTask(t.id, "go-a"), orch.runTask(t.id, "go-b")])
    expect(a.status).toBe("rejected")
    expect(b.status).toBe("rejected")
    if (a.status === "rejected" && b.status === "rejected") {
      expect(a.reason).toBeInstanceOf(Error)
      expect(b.reason).toBeInstanceOf(Error)
      expect((b.reason as Error).message).toBe((a.reason as Error).message)
    }
    expect(store.get(t.id)?.worktreePath).toBe("")
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

  test("pump consumes the stream from the chat tab's engine, not the legacy task vendor", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const claude = new HistoryEngine("claude")
    const codex = new HistoryEngine("codex")
    const orch = new Orchestrator({
      engines: { claude, codex },
      store,
      worktrees: new GitWorktreeManager(),
    })
    const t = await orch.createTask({ repo, title: "mixed vendor", prompt: "" })
    const firstTab = t.tabs[0]!
    await store.update(t.id, {
      vendor: "codex",
      tabs: [{ ...firstTab, vendor: "claude" }],
    })
    claude.script("claude-1", [{ type: "error", message: "rate limited" }])
    codex.script("claude-1", [])
    const seen: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => seen.push(ev), firstTab.id)

    await orch.runTask(t.id, "go", firstTab.id)
    await orch._waitForPumpsIdle()

    expect(claude.streamCalls).toEqual(["claude-1"])
    expect(codex.streamCalls).toEqual([])
    expect(seen.at(-1)).toEqual({ type: "error", message: "rate limited" })
    expect(store.get(t.id)?.status).toBe("error")
  })

  test("resume() includes opts.cwd = task.worktreePath (typed primary channel)", async () => {
    // Spy on a real FakeAIEngine.resume to verify the typed cwd field.
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
    const worktreePath = orch.getTask(t.id)?.worktreePath
    // Primary: the typed `opts.cwd` field — engines MUST honour this.
    expect(opts?.cwd).toBe(worktreePath)
  })

  test("resume() also sets KOBE_RESUME_CWD env var as defensive duplicate", async () => {
    // The env-var back-channel predates the typed `opts.cwd` field and
    // is kept for one release in case any external consumer still reads
    // it. Once we confirm nothing relies on it, this assertion (and the
    // env entry in the orchestrator) can be removed.
    const fake = new FakeAIEngine()
    const resumeSpy = vi.spyOn(fake, "resume")
    const { orch } = await buildOrchestrator(fake)

    const t = await orch.createTask({ repo, title: "resume me", prompt: "" })

    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "first")
    await orch._waitForPumpsIdle()

    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "second")
    await orch._waitForPumpsIdle()

    const args = resumeSpy.mock.calls[0]!
    const [, , opts] = args as [string, string, SpawnOpts | undefined]
    expect(opts?.env?.KOBE_RESUME_CWD).toBe(orch.getTask(t.id)?.worktreePath)
  })

  test("rejects with TaskNotFoundError for unknown id", async () => {
    const { orch } = await buildOrchestrator()
    await expect(orch.runTask("does-not-exist")).rejects.toBeInstanceOf(TaskNotFoundError)
  })

  test("concurrent first-prompt runTasks coalesce onto one spawn + resume the rest", async () => {
    // Regression: a fast typist firing N prompts before the chat's
    // isStreaming signal has flipped used to enter N parallel spawn
    // branches at the orchestrator, each opening a fresh JSONL session
    // and orphaning all but the last `updateTab` write. The first-spawn
    // latch is supposed to coalesce them so only one spawn fires and
    // the rest resume the just-established session.
    const fake = new FakeAIEngine()
    const spawnSpy = vi.spyOn(fake, "spawn")
    const resumeSpy = vi.spyOn(fake, "resume")
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "rapid fire", prompt: "" })

    // Pre-script "fake-1" (the only sid the spawn should hand out)
    // so each turn terminates promptly without a hand-finish.
    fake.script("fake-1", [{ type: "done" }])

    await Promise.all([orch.runTask(t.id, "1"), orch.runTask(t.id, "2"), orch.runTask(t.id, "3")])
    await orch._waitForPumpsIdle()

    // Exactly one spawn, the other two resumed against the established sid.
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
    for (const call of resumeSpy.mock.calls) {
      expect(call[0]).toBe("fake-1")
    }
    expect(store.get(t.id)?.sessionId).toBe("fake-1")
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
    // pauseTask kills the engine via stopAllTabsForTask; the pump's
    // own finally also calls engine.stop now (idempotent — registry
    // cleanup before any subscriber reacts to the buffered terminal
    // event). So stop fires once or twice depending on which lands
    // first; the contract is "at least once".
    expect(stopSpy).toHaveBeenCalled()
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
// interruptTask
// ----------------------------------------------------------------------

describe("Orchestrator.interruptTask", () => {
  test("kills the live handle and emits a system.info row, leaves status alone", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)

    const t = await orch.createTask({ repo, title: "steer", prompt: "" })
    await orch.runTask(t.id, "first prompt")
    expect(store.get(t.id)?.status).toBe("in_progress")

    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev))

    await orch.interruptTask(t.id)

    // Status unchanged — interruptTask is mid-turn redirection, not a
    // lifecycle transition.
    expect(["in_progress", "in_review"]).toContain(store.get(t.id)?.status)
    expect(stopSpy).toHaveBeenCalled()
    const sysRows = events.filter((e) => e.type === "system.info")
    expect(sysRows.some((e) => (e as { text: string }).text.includes("interrupted"))).toBe(true)
    await orch._waitForPumpsIdle()
  })

  test("is a no-op when no handle is live for the tab", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "noop", prompt: "" })
    // No runTask — no handle.
    await orch.interruptTask(t.id)
    expect(stopSpy).not.toHaveBeenCalled()
  })
})

// ----------------------------------------------------------------------
// clearTab
// ----------------------------------------------------------------------

describe("Orchestrator.clearTab", () => {
  test("drops sessionId, stops the engine, and emits chat.tab.cleared", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)

    const t = await orch.createTask({ repo, title: "clear", prompt: "" })
    await orch.runTask(t.id, "first prompt")
    const tabId = store.get(t.id)?.activeTabId ?? ""
    expect(tabId).not.toBe("")
    // runTask back-fills the tab's sessionId once the engine spawns.
    expect(store.get(t.id)?.tabs.find((x) => x.id === tabId)?.sessionId).toBeTruthy()

    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev), tabId)

    await orch.clearTab(t.id, tabId)

    expect(store.get(t.id)?.tabs.find((x) => x.id === tabId)?.sessionId).toBeNull()
    expect(stopSpy).toHaveBeenCalled()
    expect(events.some((e) => e.type === "chat.tab.cleared")).toBe(true)
    await orch._waitForPumpsIdle()
  })

  test("is safe to call on an idle tab with no live handle", async () => {
    const fake = new FakeAIEngine()
    const stopSpy = vi.spyOn(fake, "stop")
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "idle-clear", prompt: "" })
    const tabId = store.get(t.id)?.activeTabId ?? ""
    expect(tabId).not.toBe("")
    // No runTask — sessionId is already null, but clearTab must still
    // succeed and dispatch the event so any attached TUI re-renders.
    const events: OrchestratorEvent[] = []
    orch.subscribeEvents(t.id, (ev) => events.push(ev), tabId)
    await orch.clearTab(t.id, tabId)
    expect(stopSpy).not.toHaveBeenCalled()
    expect(events.some((e) => e.type === "chat.tab.cleared")).toBe(true)
  })

  test("rejects when the tab id does not exist on the task", async () => {
    const { orch } = await buildOrchestrator()
    const t = await orch.createTask({ repo, title: "bad-tab", prompt: "" })
    await expect(orch.clearTab(t.id, "no-such-tab")).rejects.toThrow(/clearTab: tab .* not found/)
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
    // See the pauseTask test note — stop fires from both archiveTask
    // and the pump's finally; the contract is "at least once".
    expect(stopSpy).toHaveBeenCalled()
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

  test("frees the worktreeSlug so a fresh task can re-use the same name (KOB-65)", async () => {
    const fake = new FakeAIEngine()
    const { orch, store } = await buildOrchestrator(fake)
    const t = await orch.createTask({ repo, title: "first", prompt: "" })
    fake.script("fake-1", [{ type: "done" }])
    await orch.runTask(t.id, "go")
    await orch._waitForPumpsIdle()

    const slug = worktreeSlug(orch.getTask(t.id)!)
    expect(slug).not.toBe("")
    const wt = orch.getTask(t.id)!.worktreePath
    expect(fs.existsSync(wt)).toBe(true)

    await orch.deleteTask(t.id)
    expect(store.get(t.id)).toBeUndefined()
    expect(fs.existsSync(wt)).toBe(false)

    // Reconstruct the orchestrator's allocator view with a pool
    // containing only the just-deleted slug. If delete cleaned up
    // both the store record AND the worktree dir, the allocator's
    // "occupied" set is empty for this slug and it gets picked
    // verbatim. If either cleanup leaked, the allocator falls back
    // to `<slug>-v2`, and this assertion fails.
    const allocator = new SlugAllocator(
      (r) =>
        store
          .list()
          .filter((task) => task.repo === r && !task.archived)
          .map((task) => worktreeSlug(task))
          .filter((s) => s.length > 0),
      { pool: [slug] },
    )
    const reused = await allocator.allocate(repo)
    expect(reused).toBe(slug)
  })

  test("keeps pending slug allocations scoped per repo (KOB-65)", async () => {
    const otherRepo = path.join(tmpRoot, "repo-other")
    fs.mkdirSync(otherRepo, { recursive: true })
    const init = spawnSync("bash", [REPO_INIT, otherRepo], { encoding: "utf8" })
    expect(init.status).toBe(0)

    const allocator = new SlugAllocator(() => [], { pool: ["panda"], random: () => 0 })
    const [a, b] = await Promise.all([allocator.allocate(repo), allocator.allocate(otherRepo)])

    expect(a).toBe("panda")
    expect(b).toBe("panda")
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
      identity: claudeIdentity,
      capabilities: claudeCapabilities,
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
        return { messages: [] }
      },
      async deleteHistory() {},
      async listSessions() {
        return []
      },
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
// ensureMainTask — KOB-15 pinned per-repo task
//
// Why this matters: the boot path in app.tsx walks getSavedRepos() and
// calls ensureMainTask(repo) for each. Idempotency is load-bearing —
// every kobe restart hits this path, and a duplicate per restart would
// fill the sidebar with stale ★ rows.
// ----------------------------------------------------------------------

describe("Orchestrator.ensureMainTask", () => {
  test("creates a main task bound to the repo root checkout (no worktree allocation)", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.ensureMainTask(repo)
    expect(t.kind).toBe("main")
    expect(t.repo).toBe(repo)
    // Bound to the repo root — NOT under .claude/worktrees/.
    expect(t.worktreePath).toBe(repo)
    // Branch is computed at display time, not stored authoritatively.
    expect(t.branch).toBe("")
    expect(t.status).toBe("backlog")
    expect(t.archived).toBe(false)
    // Title is the repo basename so the sidebar reads `repo`, not the
    // full path.
    expect(t.title).toBe(path.basename(repo))
    // Persisted exactly once.
    expect(store.list().filter((x) => x.kind === "main")).toHaveLength(1)
  })

  test("is idempotent — calling twice returns the SAME task and creates no duplicate", async () => {
    const { orch, store } = await buildOrchestrator()
    const a = await orch.ensureMainTask(repo)
    const b = await orch.ensureMainTask(repo)
    expect(b.id).toBe(a.id)
    expect(store.list().filter((x) => x.kind === "main")).toHaveLength(1)
  })

  test("two repos at different paths get separate main tasks", async () => {
    const { orch, store } = await buildOrchestrator()
    const otherRepo = path.join(tmpRoot, "repo-2")
    const result = spawnSync("bash", [REPO_INIT, otherRepo], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`repo-init.sh failed: ${result.stderr}`)
    const a = await orch.ensureMainTask(repo)
    const b = await orch.ensureMainTask(otherRepo)
    expect(a.id).not.toBe(b.id)
    expect(a.repo).toBe(repo)
    expect(b.repo).toBe(otherRepo)
    expect(store.list().filter((x) => x.kind === "main")).toHaveLength(2)
  })

  test("re-ensuring an archived main task unarchives it (re-add symmetry)", async () => {
    const { orch, store } = await buildOrchestrator()
    const a = await orch.ensureMainTask(repo)
    // Simulate the "remove from saved repos" UX: the flow archives the
    // main task instead of deleting it.
    await orch.setArchived(a.id, true)
    expect(store.get(a.id)?.archived).toBe(true)
    // Re-add via `kobe add` calls ensureMainTask again.
    const b = await orch.ensureMainTask(repo)
    expect(b.id).toBe(a.id)
    expect(b.archived).toBe(false)
  })

  test("rejects empty repo path", async () => {
    const { orch } = await buildOrchestrator()
    await expect(orch.ensureMainTask("")).rejects.toThrow()
  })

  test("consolidates a legacy subdir main task into the toplevel on re-ensure", async () => {
    // Reproduces the daemon-staleness incident: an older daemon
    // created a main task pointing at a monorepo *subdirectory*
    // (`<repo>/sub`), then a TUI on new code called
    // `ensureMainTask(<repo>)`. The duplicate must collapse — same
    // git toplevel can't have two main tasks — and the surviving
    // row's repo/worktreePath must be the canonical toplevel.
    const { orch, store } = await buildOrchestrator()
    const subdir = path.join(repo, "sub")
    fs.mkdirSync(subdir, { recursive: true })
    // Seed the legacy row directly through the store so we don't
    // rely on ensureMainTask's normalization for setup — that's the
    // code under test.
    const legacy = await store.create({
      title: "sub",
      repo: subdir,
      branch: "",
      worktreePath: subdir,
      sessionId: null,
      status: "backlog",
      archived: false,
      kind: "main",
    })
    const survivor = await orch.ensureMainTask(repo)
    const mains = store.list().filter((t) => t.kind === "main")
    expect(mains).toHaveLength(1)
    expect(mains[0]?.id).toBe(legacy.id)
    expect(survivor.id).toBe(legacy.id)
    expect(survivor.repo).toBe(repo)
    expect(survivor.worktreePath).toBe(repo)
    expect(survivor.title).toBe(path.basename(repo))
  })

  test("consolidates an archived legacy duplicate alongside a canonical row", async () => {
    // Variant: both rows already exist — the canonical one (the
    // duplicate that the stale daemon created) and an *archived*
    // legacy subdir row that deleteTask would refuse to remove
    // (CannotDeleteMainTaskError). The consolidation path must use
    // store.remove directly so the orphan actually drops.
    const { orch, store } = await buildOrchestrator()
    const subdir = path.join(repo, "sub")
    fs.mkdirSync(subdir, { recursive: true })
    const canonical = await store.create({
      title: path.basename(repo),
      repo,
      branch: "",
      worktreePath: repo,
      sessionId: null,
      status: "backlog",
      archived: false,
      kind: "main",
    })
    const archivedLegacy = await store.create({
      title: "sub",
      repo: subdir,
      branch: "",
      worktreePath: subdir,
      sessionId: null,
      status: "backlog",
      archived: true,
      kind: "main",
    })
    const survivor = await orch.ensureMainTask(repo)
    expect(survivor.id).toBe(canonical.id)
    expect(store.get(archivedLegacy.id)).toBeUndefined()
    expect(store.list().filter((t) => t.kind === "main")).toHaveLength(1)
  })
})

// ----------------------------------------------------------------------
// runTask on a main task — must skip worktree allocation
// ----------------------------------------------------------------------

describe("Orchestrator.runTask on a main task", () => {
  test("skips ensureWorktree — engine spawns with cwd = repo root, no kobe/tmp-* branch on disk", async () => {
    const calls: { cwd: string }[] = []
    const stub: AIEngine = {
      identity: claudeIdentity,
      capabilities: claudeCapabilities,
      async spawn(cwd) {
        calls.push({ cwd })
        return { sessionId: "sess-main", cwd } satisfies SessionHandle
      },
      async resume() {
        throw new Error("not used")
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
        return { messages: [] }
      },
      async deleteHistory() {},
      async listSessions() {
        return []
      },
      async stop() {},
    }
    const { orch } = await buildOrchestrator(stub)
    const t = await orch.ensureMainTask(repo)
    await orch.runTask(t.id, "first prompt")
    await orch._waitForPumpsIdle()

    // Engine cwd is the repo root, not a kobe-allocated worktree.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.cwd).toBe(repo)
    // Critical disk-state assertion: no `.claude/worktrees/<id>/`
    // directory was created. ensureWorktree would have shelled
    // `git worktree add` and left a sibling tree under the repo.
    expect(fs.existsSync(path.join(repo, ".claude", "worktrees"))).toBe(false)
    // Branch stayed empty (live-resolved at display time, not stored).
    expect(orch.getTask(t.id)?.branch).toBe("")
  })
})

// ----------------------------------------------------------------------
// deleteTask refuses main tasks — they're removed via "remove from
// saved repos" instead.
// ----------------------------------------------------------------------

describe("Orchestrator.deleteTask on a main task", () => {
  test("throws CannotDeleteMainTaskError and leaves the task untouched", async () => {
    const { orch, store } = await buildOrchestrator()
    const t = await orch.ensureMainTask(repo)
    await expect(orch.deleteTask(t.id)).rejects.toBeInstanceOf(CannotDeleteMainTaskError)
    // Task is still there, repo dir untouched.
    expect(store.get(t.id)?.kind).toBe("main")
    expect(fs.existsSync(repo)).toBe(true)
  })

  test("error message names the right escape hatch (remove from saved repos)", async () => {
    const { orch } = await buildOrchestrator()
    const t = await orch.ensureMainTask(repo)
    await expect(orch.deleteTask(t.id)).rejects.toThrow(/remove the repo from saved repos/i)
  })
})

// ----------------------------------------------------------------------
// Load-time normalisation: pre-KOB-15 records (no `kind` field) come
// back as `kind: "task"`. New main records round-trip as `kind: "main"`.
// ----------------------------------------------------------------------

describe("TaskIndexStore — kind discriminator normalization (KOB-15)", () => {
  test("records without `kind` normalize to 'task' on load", async () => {
    const manifestPath = path.join(homeDir, ".kobe", "tasks.json")
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 2,
        tasks: [
          {
            id: "01HZBXLEGACY",
            title: "legacy",
            repo: "/r",
            branch: "kobe/legacy",
            worktreePath: "/r/.claude/worktrees/01HZBXLEGACY",
            sessionId: null,
            tabs: [{ id: "tab-leg", sessionId: null, createdAt: "2026-05-08T00:00:00.000Z" }],
            activeTabId: "tab-leg",
            status: "backlog",
            archived: false,
            createdAt: "2026-05-08T00:00:00.000Z",
            updatedAt: "2026-05-08T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    )
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.kind).toBe("task")
  })

  test("records with `kind: 'main'` round-trip across save → load", async () => {
    const { orch } = await buildOrchestrator()
    await orch.ensureMainTask(repo)
    // Re-load the manifest from disk in a fresh store.
    const fresh = new TaskIndexStore({ homeDir })
    await fresh.load()
    const t = fresh.list().find((x) => x.kind === "main")
    expect(t).toBeDefined()
    expect(t?.repo).toBe(repo)
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
// maybeUpgradeTitle — background `claude -p` upgrade of the
// truncate-derived title on first run. Mirrors the branch-rename flow
// but for the sidebar label. The contract under test:
//   1. truncate-derived title gets replaced by the suggester's output
//   2. an explicit createTask({title}) is treated as load-bearing user
//      intent and is NEVER overwritten
// ----------------------------------------------------------------------

async function buildOrchestratorWithSuggester(suggested: string | null): Promise<{
  orch: Orchestrator
  store: TaskIndexStore
  fake: FakeAIEngine
}> {
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const worktrees = new GitWorktreeManager()
  const suggester = new MetadataSuggester()
  // Override the per-method probe so the test never reaches `claude -p`.
  // We don't stub resolveBinary directly because it's private; replacing
  // the public method is enough — the orchestrator only calls these.
  ;(suggester as unknown as { suggestTitle: (p: string) => Promise<string | null> }).suggestTitle = async () =>
    suggested
  ;(suggester as unknown as { suggestBranchSlug: (p: string) => Promise<string | null> }).suggestBranchSlug =
    async () => null
  const fake = new FakeAIEngine()
  const orch = new Orchestrator({ engine: fake, store, worktrees, metadataSuggester: suggester })
  return { orch, store, fake }
}

describe("Orchestrator.maybeUpgradeTitle", () => {
  test("replaces the truncate-derived title with the claude suggestion on first run", async () => {
    const { orch, store, fake } = await buildOrchestratorWithSuggester("Fix login redirect")
    fake.script("fake-1", [{ type: "done" }])
    const t = await orch.createTask({ repo, prompt: "fix login redirect please" })
    // createTask path: title comes from deriveTitleFromPrompt.
    expect(store.get(t.id)?.title).toBe("fix login redirect please")
    await orch.runTask(t.id, "fix login redirect please")
    await orch._waitForPumpsIdle()
    // The upgrade is fire-and-forget after engine.spawn resolves; flush
    // microtasks so the chained store.update settles before we assert.
    await new Promise((r) => setImmediate(r))
    expect(store.get(t.id)?.title).toBe("Fix login redirect")
  })

  test("does not overwrite an explicit createTask title", async () => {
    const { orch, store, fake } = await buildOrchestratorWithSuggester("Suggested label")
    fake.script("fake-1", [{ type: "done" }])
    const t = await orch.createTask({ repo, title: "manual title", prompt: "fix login redirect please" })
    expect(store.get(t.id)?.title).toBe("manual title")
    await orch.runTask(t.id, "fix login redirect please")
    await orch._waitForPumpsIdle()
    await new Promise((r) => setImmediate(r))
    // The suggester returned a value but the title is user-set — guard
    // holds, no rewrite.
    expect(store.get(t.id)?.title).toBe("manual title")
  })

  test("leaves the title untouched when the suggester returns null", async () => {
    const { orch, store, fake } = await buildOrchestratorWithSuggester(null)
    fake.script("fake-1", [{ type: "done" }])
    const t = await orch.createTask({ repo, prompt: "fix login redirect please" })
    await orch.runTask(t.id, "fix login redirect please")
    await orch._waitForPumpsIdle()
    await new Promise((r) => setImmediate(r))
    expect(store.get(t.id)?.title).toBe("fix login redirect please")
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
      identity: claudeIdentity,
      capabilities: claudeCapabilities,
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
        return { messages: [] }
      },
      async deleteHistory() {},
      async listSessions() {
        return []
      },
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

  test("model/vendor selection can target a chat tab explicitly", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const claude = new HistoryEngine("claude")
    const codex = new HistoryEngine("codex")
    const orch = new Orchestrator({
      engines: { claude, codex },
      store,
      worktrees: new GitWorktreeManager(),
    })

    const task = await orch.createTask({ repo, title: "mixed engines", prompt: "" })
    await orch.runTask(task.id, "first tab")
    await orch._waitForPumpsIdle()
    const firstTab = orch.getTask(task.id)?.tabs[0]
    expect(firstTab?.sessionId).toBe("claude-1")

    const secondTab = await orch.createTab(task.id)
    await orch.setModel(task.id, "gpt-5.5", secondTab.id, "xhigh")
    await orch.setActiveTab(task.id, secondTab.id)
    await orch.runTask(task.id, "second tab")
    await orch._waitForPumpsIdle()

    const updated = orch.getTask(task.id)
    const tab1 = updated?.tabs.find((t) => t.id === firstTab?.id)
    const tab2 = updated?.tabs.find((t) => t.id === secondTab.id)
    expect(tab1?.vendor).toBe("claude")
    expect(tab2?.vendor).toBe("codex")
    expect(tab2?.model).toBe("gpt-5.5")
    expect(tab2?.modelEffort).toBe("xhigh")
    expect(claude.spawns[0]?.model).toBe(claudeCapabilities.defaultModelId())
    expect(codex.spawns[0]?.model).toBe("gpt-5.5")
    expect(codex.spawns[0]?.modelEffort).toBe("xhigh")

    const firstHistory = await orch.readHistoryWithMetrics(tab1?.sessionId ?? "")
    const secondHistory = await orch.readHistoryWithMetrics(tab2?.sessionId ?? "")
    expect(firstHistory.messages[0]?.blocks).toEqual([{ type: "text", text: "claude history for claude-1" }])
    expect(secondHistory.messages[0]?.blocks).toEqual([{ type: "text", text: "codex history for codex-1" }])
  })

  test("new chat tabs inherit the active tab's model effort", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const orch = new Orchestrator({
      engines: { claude: new HistoryEngine("claude"), codex: new HistoryEngine("codex") },
      store,
      worktrees: new GitWorktreeManager(),
    })

    const task = await orch.createTask({ repo, title: "tab effort", prompt: "" })
    const firstTab = orch.getTask(task.id)?.tabs[0]
    expect(firstTab).toBeDefined()
    await orch.setModel(task.id, "gpt-5.5", firstTab!.id, "xhigh")

    const secondTab = await orch.createTab(task.id)

    expect(secondTab.model).toBe("gpt-5.5")
    expect(secondTab.modelEffort).toBe("xhigh")
    expect(secondTab.vendor).toBe("codex")
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

    // Two user.inject events fire in this flow now: the initial "go"
    // prompt (broadcast by runTask itself, so multi-attach clients see
    // the user message) and the synthetic approval-response prompt
    // from respondToInput. The synthetic one is what we care about
    // here — it's the last user.inject.
    const injects = events.filter(
      (e): e is Extract<OrchestratorEvent, { type: "user.inject" }> => e.type === "user.inject",
    )
    expect(injects[injects.length - 1]?.text.toLowerCase()).toContain("approved")
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

    // The synthetic answer prompt is the LAST user.inject — the first
    // is runTask broadcasting the initial "go" prompt so multi-attach
    // clients receive it.
    const injects = events.filter(
      (e): e is Extract<OrchestratorEvent, { type: "user.inject" }> => e.type === "user.inject",
    )
    expect(injects[injects.length - 1]?.text).toContain("Which library? → date-fns")
  })
})
