import { describe, expect, test } from "vitest"
import { activeTaskSessionId } from "../../src/tui/component/top-bar-helpers"
import { type Task, toTaskId } from "../../src/types/task"

function taskWithTabs(activeTabId: string): Task {
  return {
    id: toTaskId("01TEST"),
    title: "demo",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.claude/worktrees/01TEST",
    sessionId: "legacy-session",
    tabs: [
      { id: "tab-a", sessionId: "session-a-1234567890", seq: 1, createdAt: "2026-05-12T00:00:00.000Z" },
      { id: "tab-b", sessionId: "session-b-1234567890", seq: 2, createdAt: "2026-05-12T00:00:00.000Z" },
    ],
    activeTabId,
    status: "in_progress",
    archived: false,
    createdAt: "2026-05-12T00:00:00.000Z",
    updatedAt: "2026-05-12T00:00:00.000Z",
  }
}

describe("activeTaskSessionId", () => {
  test("uses the active chat tab session id", () => {
    expect(activeTaskSessionId(taskWithTabs("tab-a"), "tab-b")).toBe("session-b-1234567890")
  })

  test("falls back to the task active tab", () => {
    expect(activeTaskSessionId(taskWithTabs("tab-a"), null)).toBe("session-a-1234567890")
  })

  test("does not fall back to the legacy task session id when the active tab is missing", () => {
    expect(activeTaskSessionId(taskWithTabs("missing"), "missing")).toBeNull()
  })
})
