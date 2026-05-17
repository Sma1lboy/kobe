import type { ChatRunState } from "@/orchestrator/core"
import { computeBackgroundRows } from "@/tui/component/background-tasks-parts"
import type { Task } from "@/types/task"
import { describe, expect, test } from "vitest"

/** Minimal Task fixture — `computeBackgroundRows` only reads id/title/tabs. */
function task(id: string, title: string, tabs: Array<{ id: string; title?: string; seq: number }>): Task {
  return { id, title, tabs } as unknown as Task
}

const tasks: Task[] = [
  task("t1", "Alpha task", [{ id: "tab-a", title: "feature", seq: 1 }]),
  task("t2", "Beta task", [{ id: "tab-b", seq: 3 }]),
]

function runState(entries: Array<[string, ChatRunState]>): ReadonlyMap<string, ChatRunState> {
  return new Map(entries)
}

describe("computeBackgroundRows", () => {
  test("projects run-state entries into resolved rows", () => {
    const rows = computeBackgroundRows(runState([["t1:tab-a", "running"]]), tasks, null)
    expect(rows).toEqual([
      { taskId: "t1", tabId: "tab-a", taskTitle: "Alpha task", tabLabel: "feature", state: "running" },
    ])
  })

  test("falls back to `chat <seq>` when a tab has no title", () => {
    const rows = computeBackgroundRows(runState([["t2:tab-b", "running"]]), tasks, null)
    expect(rows[0]?.tabLabel).toBe("chat 3")
  })

  test("excludes the currently-visible tab", () => {
    const rs = runState([
      ["t1:tab-a", "running"],
      ["t2:tab-b", "running"],
    ])
    const rows = computeBackgroundRows(rs, tasks, "t1:tab-a")
    expect(rows.map((r) => r.taskId)).toEqual(["t2"])
  })

  test("sorts awaiting_input ahead of running", () => {
    const rs = runState([
      ["t1:tab-a", "running"],
      ["t2:tab-b", "awaiting_input"],
    ])
    const rows = computeBackgroundRows(rs, tasks, null)
    expect(rows.map((r) => r.state)).toEqual(["awaiting_input", "running"])
  })

  test("drops keys whose task or tab no longer exists", () => {
    const rs = runState([
      ["gone:tab-x", "running"],
      ["t1:missing-tab", "running"],
      ["malformed-key", "running"],
    ])
    // gone task → dropped; missing tab → kept with `chat ?` fallback;
    // malformed key (no `:`) → dropped.
    const rows = computeBackgroundRows(rs, tasks, null)
    expect(rows).toEqual([
      { taskId: "t1", tabId: "missing-tab", taskTitle: "Alpha task", tabLabel: "chat ?", state: "running" },
    ])
  })
})
