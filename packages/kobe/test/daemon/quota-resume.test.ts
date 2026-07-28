import { describe, expect, it, vi } from "vitest"
import type { DaemonOrchestrator, DaemonTask } from "../../../kobe-daemon/src/daemon/contracts.ts"
import {
  QUOTA_RESUME_CONTINUE_PROMPT,
  dueQuotaResumes,
  scheduleQuotaResume,
  startQuotaResumeRunner,
} from "../../../kobe-daemon/src/daemon/quota-resume.ts"
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

describe("scheduleQuotaResume", () => {
  it("arms the schedule from the engine-owned probe's reset time", async () => {
    const orch = fakeOrch([task("t1")])
    const runtime = {
      defaultTaskVendor: "claude",
      quotaResetAtMs: vi.fn(async () => NOW + 5000),
    } as unknown as DaemonRuntimeAdapter
    await scheduleQuotaResume(orch, runtime, "t1", () => NOW)
    expect(orch.setQuotaResume).toHaveBeenCalledWith("t1", {
      resumeAt: new Date(NOW + 5000).toISOString(),
      requestedAt: new Date(NOW).toISOString(),
    })
  })

  it("arms nothing when the probe cannot produce a reset time", async () => {
    const orch = fakeOrch([task("t1")])
    const runtime = {
      defaultTaskVendor: "claude",
      quotaResetAtMs: vi.fn(async () => null),
    } as unknown as DaemonRuntimeAdapter
    await scheduleQuotaResume(orch, runtime, "t1", () => NOW)
    expect(orch.setQuotaResume).not.toHaveBeenCalled()
  })

  it("ignores unknown and deleting tasks", async () => {
    const quotaResetAtMs = vi.fn(async () => NOW + 5000)
    const orch = fakeOrch([task("deleting", { deletion: { phase: "queued", force: false, requestedAt: PAST } })])
    const runtime = { defaultTaskVendor: "claude", quotaResetAtMs } as unknown as DaemonRuntimeAdapter
    await scheduleQuotaResume(orch, runtime, "missing", () => NOW)
    await scheduleQuotaResume(orch, runtime, "deleting", () => NOW)
    expect(quotaResetAtMs).not.toHaveBeenCalled()
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
