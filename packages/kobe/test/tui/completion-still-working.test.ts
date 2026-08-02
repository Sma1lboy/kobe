import { describe, expect, it } from "vitest"
import { buildSidebarRowView, rowIsLoading } from "../../src/tui/panes/sidebar/row-view.ts"
import type { Task } from "../../src/types/task.ts"

/**
 * Measured on a real session (2026-07-29): `turn-complete` fired at
 * 07:17:41 and the next hook of ANY kind arrived at 07:27:11 — nine
 * minutes in which the engine was visibly working ("Twisting… 8m57s") and
 * the row showed a done ✓. The transcript kept growing the whole time,
 * which is the only signal that survives that silence.
 */
const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1",
    title: "codefox-qikl",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.kobe/worktrees/demo",
    kind: "task",
    status: "in_progress",
    archived: false,
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  }) as Task

const COMPLETE_AT = 1_000_000
const view = (transcript?: { mtimeMs: number }, completionSeen = false) =>
  buildSidebarRowView({
    task: task(),
    activity: { state: "turn_complete", at: COMPLETE_AT },
    ...(transcript ? { transcript } : {}),
    completionSeen,
    spinnerFrame: 0,
    subtitleBudget: 80,
    truncateBranch: (b) => b,
  })

describe("a completion the transcript outlived", () => {
  it("keeps the row spinning while the transcript grows after the hook", () => {
    const working = { mtimeMs: COMPLETE_AT + 60_000 }
    expect(
      rowIsLoading({ task: task(), activity: { state: "turn_complete", at: COMPLETE_AT }, transcript: working }),
    ).toBe(true)
    expect(view(working).loading).toBe(true)
  })

  it("shows no done mark while it is still working — badge agrees with the spinner", () => {
    const row = view({ mtimeMs: COMPLETE_AT + 60_000 }, true)
    expect(row.stateGlyph).not.toBe("✓")
    expect(row.stateGlyph).not.toBe("●")
  })

  it("settles once the final hook overtakes the last write", () => {
    // The real end: the Stop hook fires AFTER the last transcript write, so
    // its timestamp wins and no timeout is needed to recover. Seen =
    // consumed (owner 2026-08-02), so the settled badge is the idle circle.
    const settled = view({ mtimeMs: COMPLETE_AT - 500 }, true)
    expect(settled.loading).toBe(false)
    expect(settled.stateGlyph).toBe("○")
  })

  it("ignores the sub-second race between the last write and the hook", () => {
    expect(view({ mtimeMs: COMPLETE_AT + 400 }).loading).toBe(false)
  })

  it("is inert without transcript facts (no daemon data → old behaviour)", () => {
    expect(view().loading).toBe(false)
    expect(view({ mtimeMs: 0 }).loading).toBe(false)
  })
})
