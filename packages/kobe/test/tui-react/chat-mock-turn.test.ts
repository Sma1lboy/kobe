/**
 * Unit tests for `src/tui/chat/mock-turn.ts` — the scripted fake harness
 * turn behind `dev:mock-react-chat` (issue #15 G3).
 *
 * Why this matters: the mock is the render proof for the React chat pane —
 * if the script stops emitting growing snapshots, ending with the greppable
 * summary line, the live gate silently loses its assertion target. The
 * module is framework-free (type-only imports), so it runs directly under
 * vitest's node environment.
 */

import type { UIMessage } from "ai"
import { describe, expect, test } from "vitest"
import {
  MOCK_CHAT_DONE_TEXT,
  MOCK_CHAT_PROMPT,
  MOCK_CHAT_WORKTREE,
  createMockStartTurn,
} from "../../src/tui/chat/mock-turn"

function collect(stepMs: number) {
  const updates: UIMessage[] = []
  const turn = createMockStartTurn(stepMs)({
    worktree: MOCK_CHAT_WORKTREE,
    prompt: MOCK_CHAT_PROMPT,
    onUpdate: (msg) => updates.push(msg),
  })
  return { updates, turn }
}

describe("createMockStartTurn", () => {
  test("streams growing assistant snapshots and resolves without error", async () => {
    const { updates, turn } = collect(1)
    const { error } = await turn.done
    expect(error).toBeUndefined()
    expect(updates.length).toBeGreaterThanOrEqual(4)
    // Snapshots REPLACE the tail (ChatPane contract): same id, growing parts.
    expect(new Set(updates.map((u) => u.id)).size).toBe(1)
    for (let i = 1; i < updates.length; i++) {
      const prev = updates[i - 1]
      const cur = updates[i]
      if (!prev || !cur) throw new Error("unreachable: bounded loop")
      expect(cur.parts.length).toBeGreaterThanOrEqual(prev.parts.length)
    }
    // The dev:mock-react-chat live gate greps for the final summary line.
    const last = updates.at(-1)
    expect(last?.parts.some((p) => p.type === "text" && p.text === MOCK_CHAT_DONE_TEXT)).toBe(true)
    // The tool call resolves through the dynamic-tool state machine.
    expect(last?.parts.some((p) => p.type === "dynamic-tool" && p.state === "output-available")).toBe(true)
  })

  test("interrupt stops the script mid-stream", async () => {
    const { updates, turn } = collect(60_000) // steps far beyond the test's lifetime
    turn.interrupt()
    const { error } = await turn.done
    expect(error).toBeUndefined()
    expect(updates.length).toBe(0)
  })
})
