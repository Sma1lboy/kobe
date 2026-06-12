import { describe, expect, it } from "vitest"
import {
  type AutoReviewDeps,
  type StatusJudgeOrchestrator,
  buildJudgePrompt,
  isReviewCandidate,
  lastAssistantTextFromMessages,
  maybeAutoReview,
  parseVerdict,
} from "../../src/monitor/status-judge.ts"
import type { Message } from "../../src/types/engine.ts"
import type { Task, TaskStatus } from "../../src/types/task.ts"

/**
 * Auto in-review judge (web-kanban.md M5). The load-bearing rules: the ONLY
 * transition ever made is in_progress → in_review; every failure path skips;
 * a user move during the (slow) judge call wins via the post-judge re-check;
 * and the free heuristic gate runs BEFORE any model call.
 */

const task = (over: Partial<Task>): Task =>
  ({
    id: "t1",
    title: "demo",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.kobe/worktrees/demo",
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  }) as Task

function fakeOrch(initial: Task): StatusJudgeOrchestrator & {
  moves: Array<[string, TaskStatus]>
  current: Task | undefined
} {
  return {
    current: initial,
    moves: [],
    getTask() {
      return this.current
    },
    async setStatus(id: string, status: TaskStatus) {
      this.moves.push([id, status])
    },
  }
}

function deps(over: Partial<AutoReviewDeps> = {}): AutoReviewDeps {
  return {
    enabled: () => true,
    lastAssistantText: async () => "All done — tests pass, committed.",
    isDirty: async () => true,
    judge: async () => true,
    ...over,
  }
}

describe("maybeAutoReview — pipeline", () => {
  it("moves an in_progress dirty task whose judge says REVIEW", async () => {
    const orch = fakeOrch(task({}))
    await expect(maybeAutoReview(orch, "t1", deps())).resolves.toBe("moved")
    expect(orch.moves).toEqual([["t1", "in_review"]])
  })

  it("skips when the feature is disabled (default-off)", async () => {
    const orch = fakeOrch(task({}))
    const result = await maybeAutoReview(orch, "t1", deps({ enabled: () => false }))
    expect(result).toBe("skipped")
    expect(orch.moves).toEqual([])
  })

  it("free gate: clean worktree with no PR never reaches the judge", async () => {
    const orch = fakeOrch(task({}))
    let judged = 0
    const result = await maybeAutoReview(
      orch,
      "t1",
      deps({
        isDirty: async () => false,
        judge: async () => {
          judged += 1
          return true
        },
      }),
    )
    expect(result).toBe("skipped")
    expect(judged).toBe(0)
  })

  it("an open PR is review evidence even with a clean worktree", async () => {
    const orch = fakeOrch(task({ prStatus: { provider: "github", lifecycle: "open", checkState: "passing" } }))
    await expect(maybeAutoReview(orch, "t1", deps({ isDirty: async () => false }))).resolves.toBe("moved")
  })

  it("only in_progress tasks are candidates — never re-judges in_review/done", async () => {
    for (const status of ["backlog", "in_review", "done", "canceled", "error"] as const) {
      const orch = fakeOrch(task({ status }))
      await expect(maybeAutoReview(orch, "t1", deps())).resolves.toBe("skipped")
      expect(orch.moves).toEqual([])
    }
  })

  it("a CONTINUE / unusable verdict skips", async () => {
    for (const verdict of [false, null] as const) {
      const orch = fakeOrch(task({}))
      const result = await maybeAutoReview(orch, "t1", deps({ judge: async () => verdict }))
      expect(result).toBe("skipped")
      expect(orch.moves).toEqual([])
    }
  })

  it("a user move during the judge call wins (post-judge re-check)", async () => {
    const orch = fakeOrch(task({}))
    const result = await maybeAutoReview(
      orch,
      "t1",
      deps({
        judge: async () => {
          // While the judge runs, the user drags the card to done.
          orch.current = task({ status: "done" })
          return true
        },
      }),
    )
    expect(result).toBe("skipped")
    expect(orch.moves).toEqual([])
  })

  it("main / archived tasks are never judged", async () => {
    for (const t of [task({ kind: "main" }), task({ archived: true })]) {
      const orch = fakeOrch(t)
      await expect(maybeAutoReview(orch, "t1", deps())).resolves.toBe("skipped")
    }
  })

  it("an empty final message skips (nothing to judge)", async () => {
    const orch = fakeOrch(task({}))
    const result = await maybeAutoReview(orch, "t1", deps({ lastAssistantText: async () => "" }))
    expect(result).toBe("skipped")
  })
})

describe("parseVerdict", () => {
  it("accepts the one-word contract and tolerates prefix noise", () => {
    expect(parseVerdict("REVIEW")).toBe(true)
    expect(parseVerdict("review\n")).toBe(true)
    expect(parseVerdict("CONTINUE")).toBe(false)
    expect(parseVerdict("continue — the agent asked a question")).toBe(false)
    expect(parseVerdict("The verdict is REVIEW.")).toBe(true)
    // Ambiguous output (mentions both words) is unusable → null → skip.
    expect(parseVerdict("It could be REVIEW or CONTINUE")).toBeNull()
    expect(parseVerdict("")).toBeNull()
    expect(parseVerdict("I am not sure")).toBeNull()
  })
})

describe("isReviewCandidate / prompt / message extraction", () => {
  it("requires in_progress + evidence", () => {
    expect(isReviewCandidate(task({}), true)).toBe(true)
    expect(isReviewCandidate(task({}), false)).toBe(false)
    expect(isReviewCandidate(task({ status: "backlog" }), true)).toBe(false)
  })

  it("buildJudgePrompt keeps the END of an over-long message", () => {
    const message = `${"x".repeat(10_000)}THE-ENDING`
    const prompt = buildJudgePrompt(message)
    expect(prompt).toContain("THE-ENDING")
    expect(prompt.length).toBeLessThan(6_000)
  })

  it("lastAssistantTextFromMessages takes the last assistant TEXT", () => {
    const messages = [
      { role: "user", blocks: [{ type: "text", text: "do it" }] },
      { role: "assistant", blocks: [{ type: "text", text: "working…" }] },
      { role: "user", blocks: [{ type: "text", text: "ok" }] },
      { role: "assistant", blocks: [{ type: "text", text: "done, tests pass" }] },
    ] as unknown as Message[]
    expect(lastAssistantTextFromMessages(messages)).toBe("done, tests pass")
    expect(lastAssistantTextFromMessages([])).toBe("")
  })
})
