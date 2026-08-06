import { describe, expect, it } from "vitest"
import type { HistoryMessage } from "../src/lib/history.ts"
import { buildTimeline, withLiveState } from "../src/lib/timeline.ts"

const sessionId = "codex-session"
const message = (
  role: HistoryMessage["role"],
  timestamp: string,
  blocks: HistoryMessage["blocks"],
  phase?: HistoryMessage["phase"],
): HistoryMessage => ({
  role,
  timestamp,
  blocks,
  sessionId,
  ...(phase ? { phase } : {}),
})

describe("buildTimeline", () => {
  it("groups Codex tool results under the user turn that caused them", () => {
    const timeline = buildTimeline([
      message("user", "2026-08-06T10:00:00.000Z", [
        { type: "text", text: "Fix the auth race" },
      ]),
      message("assistant", "2026-08-06T10:00:01.000Z", [
        { type: "thinking", text: "Inspect the session lock first." },
      ]),
      message("assistant", "2026-08-06T10:00:02.000Z", [
        {
          type: "tool_call",
          callId: "call-1",
          name: "apply_patch",
          input: { file_path: "src/auth.ts" },
        },
      ]),
      message("user", "2026-08-06T10:00:04.000Z", [
        { type: "tool_result", callId: "call-1", output: "Done", isError: false },
      ]),
      message("assistant", "2026-08-06T10:00:05.000Z", [
        { type: "text", text: "Fixed the race." },
      ]),
    ])

    expect(timeline.turns).toHaveLength(1)
    expect(timeline.turns[0]?.title).toBe("Fix the auth race")
    expect(timeline.turns[0]?.items.map((item) => item.kind)).toEqual([
      "reasoning",
      "change",
      "response",
    ])
    expect(timeline.turns[0]?.items[1]).toMatchObject({
      id: "tool:call-1",
      parentId: timeline.turns[0]?.items[0]?.id,
      status: "success",
      endedAt: Date.parse("2026-08-06T10:00:04.000Z"),
    })
  })

  it("hangs Codex tool calls from the visible commentary that motivated them", () => {
    const timeline = buildTimeline([
      message("user", "2026-08-06T10:00:00.000Z", [
        { type: "text", text: "Diagnose the failing test" },
      ]),
      message(
        "assistant",
        "2026-08-06T10:00:01.000Z",
        [{ type: "text", text: "I will inspect the focused test first." }],
        "commentary",
      ),
      message("assistant", "2026-08-06T10:00:02.000Z", [
        {
          type: "tool_call",
          callId: "read",
          name: "exec",
          input: { cmd: "sed -n '1,120p' test.ts" },
        },
      ]),
      message("user", "2026-08-06T10:00:03.000Z", [
        { type: "tool_result", callId: "read", output: "...", isError: false },
      ]),
      message(
        "assistant",
        "2026-08-06T10:00:04.000Z",
        [{ type: "text", text: "The fixture is stale, so I will patch it." }],
        "commentary",
      ),
      message("assistant", "2026-08-06T10:00:05.000Z", [
        {
          type: "tool_call",
          callId: "patch",
          name: "apply_patch",
          input: { file_path: "test.ts" },
        },
      ]),
      message("user", "2026-08-06T10:00:06.000Z", [
        { type: "tool_result", callId: "patch", output: "Done", isError: false },
      ]),
      message(
        "assistant",
        "2026-08-06T10:00:07.000Z",
        [{ type: "text", text: "The focused test now passes." }],
        "final",
      ),
    ])

    const items = timeline.turns[0]?.items ?? []
    expect(items.map((item) => item.kind)).toEqual([
      "thought",
      "tool",
      "thought",
      "change",
      "response",
    ])
    expect(items[1]?.parentId).toBe(items[0]?.id)
    expect(items[0]?.detail).toBe("I will inspect the focused test first.")
    expect(items[1]).toMatchObject({
      detail: '{\n  "cmd": "sed -n \'1,120p\' test.ts"\n}',
      resultDetail: "...",
    })
    expect(items[3]?.parentId).toBe(items[2]?.id)
    expect(items[4]?.parentId).toBeNull()
  })

  it("does not mistake a tool_result user record for a new turn", () => {
    const timeline = buildTimeline([
      message("assistant", "2026-08-06T10:00:00.000Z", [
        { type: "tool_call", callId: "c", name: "shell", input: { command: "pwd" } },
      ]),
      message("user", "2026-08-06T10:00:01.000Z", [
        { type: "tool_result", callId: "c", output: "/repo", isError: false },
      ]),
    ])

    expect(timeline.turns).toHaveLength(1)
    expect(timeline.turns[0]?.title).toBe("Session activity")
    expect(timeline.turns[0]?.items[0]?.status).toBe("success")
  })

  it("closes an empty turn when the next user turn begins", () => {
    const timeline = buildTimeline([
      message("user", "2026-08-06T10:00:00.000Z", [
        { type: "text", text: "First" },
      ]),
      message("user", "2026-08-06T10:00:05.000Z", [
        { type: "text", text: "Second" },
      ]),
    ])

    expect(timeline.turns[0]?.endedAt).toBe(
      Date.parse("2026-08-06T10:00:05.000Z"),
    )
  })

  it("marks failed and still-running tools", () => {
    const timeline = buildTimeline([
      message("user", "2026-08-06T10:00:00.000Z", [
        { type: "text", text: "Run checks" },
      ]),
      message("assistant", "2026-08-06T10:00:01.000Z", [
        { type: "tool_call", callId: "failed", name: "shell", input: {} },
        { type: "tool_call", callId: "live", name: "shell", input: {} },
      ]),
      message("user", "2026-08-06T10:00:02.000Z", [
        { type: "tool_result", callId: "failed", output: "boom", isError: true },
      ]),
    ])

    expect(timeline.turns[0]?.status).toBe("error")
    expect(timeline.turns[0]?.items.map((item) => item.status)).toEqual([
      "error",
      "running",
    ])
  })
})

describe("withLiveState", () => {
  it("shows activity before Codex history persists", () => {
    const timeline = withLiveState(buildTimeline([]), "running", 42)
    expect(timeline.turns[0]).toMatchObject({
      title: "Current turn",
      status: "running",
      startedAt: 42,
    })
  })

  it("adds a live root when a new turn starts after settled history", () => {
    const settled = buildTimeline([
      message("user", "2026-08-06T10:00:00.000Z", [
        { type: "text", text: "First turn" },
      ]),
      message("assistant", "2026-08-06T10:00:01.000Z", [
        { type: "text", text: "Done" },
      ]),
    ])
    const nextAt = Date.parse("2026-08-06T10:01:00.000Z")
    const timeline = withLiveState(settled, "running", nextAt)

    expect(timeline.turns).toHaveLength(2)
    expect(timeline.turns[1]).toMatchObject({
      title: "Current turn",
      status: "running",
      startedAt: nextAt,
    })
  })
})
