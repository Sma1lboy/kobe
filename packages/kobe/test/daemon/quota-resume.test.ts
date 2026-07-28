import { describe, expect, it, vi } from "vitest"
import type { DaemonOrchestrator, DaemonTask, EngineQuotaUsage } from "../../../kobe-daemon/src/daemon/contracts.ts"
import {
  QUOTA_RESUME_CONTINUE_PROMPT,
  dueQuotaResumes,
  exhaustedResetAtMs,
  scheduleQuotaResume,
  startQuotaResumeRunner,
} from "../../../kobe-daemon/src/daemon/quota-resume.ts"
import type { QuotaUsageCache } from "../../../kobe-daemon/src/daemon/quota-usage-cache.ts"
import type { DaemonRuntimeAdapter } from "../../../kobe-daemon/src/daemon/runtime.ts"

const NOW = Date.parse("2026-07-27T12:00:00.000Z")
const PAST = new Date(NOW - 1000).toISOString()
const FUTURE = new Date(NOW + 60 * 60 * 1000).toISOString()

function task(id: string, overrides: Partial<DaemonTask> = {}): DaemonTask {
  return {
    id,
    title: id,
    repo: "/repo",
    branch: "branch",
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "in_progress",
    archived: false,
    vendor: "claude",
    createdAt: PAST,
    updatedAt: PAST,
    ...overrides,
  }
}

const schedule = (resumeAt: string) => ({ resumeAt, requestedAt: PAST })

describe("dueQuotaResumes", () => {
  it("selects only armed tasks whose resumeAt has passed", () => {
    const due = dueQuotaResumes(
      [task("due", { quotaResume: schedule(PAST) }), task("later", { quotaResume: schedule(FUTURE) }), task("unarmed")],
      NOW,
    )
    expect(due.map((t) => t.id)).toEqual(["due"])
  })

  it("skips deleting, archived, worktree-less, and unparseable schedules", () => {
    const due = dueQuotaResumes(
      [
        task("deleting", {
          quotaResume: schedule(PAST),
          deletion: { phase: "queued", force: false, requestedAt: PAST },
        }),
        task("archived", { quotaResume: schedule(PAST), archived: true }),
        task("no-wt", { quotaResume: schedule(PAST), worktreePath: "" }),
        task("garbage", { quotaResume: schedule("not-a-date") }),
      ],
      NOW,
    )
    expect(due).toEqual([])
  })
})

function fakeOrch(tasks: DaemonTask[]): DaemonOrchestrator & { setQuotaResume: ReturnType<typeof vi.fn> } {
  return {
    listTasks: () => tasks,
    getTask: (id: string) => tasks.find((t) => t.id === id),
    setQuotaResume: vi.fn(async () => {}),
  } as unknown as DaemonOrchestrator & { setQuotaResume: ReturnType<typeof vi.fn> }
}

const RUNTIME = { defaultTaskVendor: "claude" } as unknown as DaemonRuntimeAdapter

function fakeCache(usage: EngineQuotaUsage | null): QuotaUsageCache & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => usage) } as unknown as QuotaUsageCache & { get: ReturnType<typeof vi.fn> }
}

const exhaustedUsage = (resetsAt: number): EngineQuotaUsage => ({
  windows: [{ kind: "session", label: "5h", percent: 100, resetsAt }],
  capturedAt: NOW,
})

describe("exhaustedResetAtMs", () => {
  it("returns the earliest future reset among exhausted windows only", () => {
    const usage: EngineQuotaUsage = {
      windows: [
        { kind: "session", label: "5h", percent: 40, resetsAt: NOW + 1000 },
        { kind: "weekly_all", label: "7d", percent: 100, resetsAt: NOW + 5000 },
        { kind: "weekly_scoped", label: "Fable", percent: 100, resetsAt: NOW + 2000 },
      ],
      capturedAt: NOW,
    }
    expect(exhaustedResetAtMs(usage, NOW)).toBe(NOW + 2000)
  })

  it("returns null when nothing is exhausted or resets are missing/past", () => {
    const usage: EngineQuotaUsage = {
      windows: [
        { kind: "session", label: "5h", percent: 99, resetsAt: NOW + 1000 },
        { kind: "weekly_all", label: "7d", percent: 100, resetsAt: null },
        { kind: "weekly_scoped", label: "Fable", percent: 100, resetsAt: NOW - 1000 },
      ],
      capturedAt: NOW,
    }
    expect(exhaustedResetAtMs(usage, NOW)).toBeNull()
  })
})

describe("scheduleQuotaResume", () => {
  it("arms the schedule from the cached usage's exhausted reset time", async () => {
    const orch = fakeOrch([task("t1")])
    const cache = fakeCache(exhaustedUsage(NOW + 5000))
    await scheduleQuotaResume(orch, RUNTIME, cache, "t1", () => NOW)
    expect(cache.get).toHaveBeenCalledWith("claude", 0)
    expect(orch.setQuotaResume).toHaveBeenCalledWith("t1", {
      resumeAt: new Date(NOW + 5000).toISOString(),
      requestedAt: new Date(NOW).toISOString(),
    })
  })

  it("arms nothing when the cache has no usage or nothing is exhausted", async () => {
    const orch = fakeOrch([task("t1")])
    await scheduleQuotaResume(orch, RUNTIME, fakeCache(null), "t1", () => NOW)
    await scheduleQuotaResume(orch, RUNTIME, fakeCache({ windows: [], capturedAt: NOW }), "t1", () => NOW)
    expect(orch.setQuotaResume).not.toHaveBeenCalled()
  })

  it("ignores unknown and deleting tasks", async () => {
    const cache = fakeCache(exhaustedUsage(NOW + 5000))
    const orch = fakeOrch([task("deleting", { deletion: { phase: "queued", force: false, requestedAt: PAST } })])
    await scheduleQuotaResume(orch, RUNTIME, cache, "missing", () => NOW)
    await scheduleQuotaResume(orch, RUNTIME, cache, "deleting", () => NOW)
    expect(cache.get).not.toHaveBeenCalled()
  })
})

describe("startQuotaResumeRunner", () => {
  it("clears the schedule before delivering the continue prompt into the live session", async () => {
    const order: string[] = []
    const due = task("t1", { quotaResume: schedule(PAST) })
    const orch = fakeOrch([due])
    orch.setQuotaResume.mockImplementation(async () => {
      order.push("clear")
    })
    const deliverPromptToLiveEngine = vi.fn(async () => {
      order.push("deliver")
      return true
    })
    const runtime = { deliverPromptToLiveEngine } as unknown as DaemonRuntimeAdapter

    const stop = startQuotaResumeRunner(orch, runtime, 5, () => NOW)
    try {
      await vi.waitFor(() => expect(deliverPromptToLiveEngine).toHaveBeenCalled())
    } finally {
      stop()
    }

    expect(order.slice(0, 2)).toEqual(["clear", "deliver"])
    expect(orch.setQuotaResume).toHaveBeenCalledWith("t1", null)
    expect(deliverPromptToLiveEngine).toHaveBeenCalledWith(
      { id: "t1", vendor: "claude", worktreePath: "/wt/t1" },
      QUOTA_RESUME_CONTINUE_PROMPT,
    )
  })

  it("leaves future schedules untouched", async () => {
    const orch = fakeOrch([task("t1", { quotaResume: schedule(FUTURE) })])
    const deliverPromptToLiveEngine = vi.fn(async () => true)
    const runtime = { deliverPromptToLiveEngine } as unknown as DaemonRuntimeAdapter

    const stop = startQuotaResumeRunner(orch, runtime, 5, () => NOW)
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
    } finally {
      stop()
    }
    expect(deliverPromptToLiveEngine).not.toHaveBeenCalled()
    expect(orch.setQuotaResume).not.toHaveBeenCalled()
  })
})
