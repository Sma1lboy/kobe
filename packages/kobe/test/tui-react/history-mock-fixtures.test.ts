import { describe, expect, it } from "vitest"
import {
  MOCK_HISTORY_SESSION_ID,
  MOCK_HISTORY_WORKTREE,
  createMockHistoryReader,
  seedHistoryMessages,
} from "../../src/tui/history/mock-fixtures"

describe("history mock fixtures", () => {
  it("seed messages are non-empty and renderable (roles + text present)", () => {
    const messages = seedHistoryMessages()
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.some((m) => m.role === "assistant")).toBe(true)
  })

  it("fake reader honors the EngineHistoryReader contract for the mock worktree", async () => {
    const reader = createMockHistoryReader()
    await expect(reader.listSessionIdsForWorktree(MOCK_HISTORY_WORKTREE)).resolves.toContain(MOCK_HISTORY_SESSION_ID)
    const history = await reader.readHistory(MOCK_HISTORY_SESSION_ID)
    expect(history.length).toBe(seedHistoryMessages().length)
  })

  it("fake reader serves fixture sessions for ANY worktree and a short stub for other ids", async () => {
    // Deliberate mock semantics: it's demo data, not a lookup — every
    // worktree sees the fixture sessions, and non-primary ids get a 2-message
    // stub so the session switcher has something to show.
    const reader = createMockHistoryReader()
    await expect(reader.listSessionIdsForWorktree("/not/mocked")).resolves.toContain(MOCK_HISTORY_SESSION_ID)
    await expect(reader.readHistory("mock-session-old")).resolves.toHaveLength(2)
  })
})
