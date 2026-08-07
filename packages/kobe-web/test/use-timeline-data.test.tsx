// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineTrace, TraceTurn } from "../src/lib/trace.ts"
import type {
  EngineSessionBinding,
  EngineSessionTransition,
} from "../src/lib/types.ts"

const { fetchTrace } = vi.hoisted(() => ({
  fetchTrace: vi.fn<(vendor: string, sessionId: string) => Promise<EngineTrace>>(),
}))

vi.mock("../src/lib/trace.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/trace.ts")>()
  return {
    ...actual,
    fetchTrace,
    subscribeTrace: vi.fn(() => () => undefined),
    subscribeLiveTrace: vi.fn(() => () => undefined),
  }
})

import { useTimelineData } from "../src/lib/use-timeline-data.ts"

function turn(id: string, startedAt: number, endedAt: number): TraceTurn {
  return {
    id,
    title: id,
    startedAt,
    endedAt,
    status: "success",
    nodes: [],
  }
}

function binding(runId: string, sessionId: string, startedAt: number): EngineSessionBinding {
  return {
    runId,
    taskId: "task-1",
    tabId: "tab-1",
    vendor: "codex",
    sessionId,
    state: "bound",
    source: "hook",
    startSource: "resume",
    startedAt,
    boundAt: startedAt,
    updatedAt: startedAt,
  }
}

describe("useTimelineData", () => {
  beforeEach(() => {
    fetchTrace.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it("restores the complete session timeline after resuming away and back", async () => {
    const sessionA: EngineTrace = {
      sessionId: "session-a",
      turns: [turn("a-old", 10, 20), turn("a-new", 110, 120)],
    }
    const sessionB: EngineTrace = {
      sessionId: "session-b",
      turns: [turn("b-turn", 50, 60)],
    }
    fetchTrace.mockImplementation(async (_vendor, sessionId) =>
      sessionId === "session-a" ? sessionA : sessionB,
    )

    const { result, rerender } = renderHook(
      ({ currentBinding }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState: undefined,
          binding: currentBinding,
        }),
      { initialProps: { currentBinding: binding("run-a1", "session-a", 1) } },
    )

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.model.turns.map((item) => item.id)).toEqual(["a-old", "a-new"])

    act(() => rerender({ currentBinding: binding("run-b", "session-b", 40) }))
    expect(result.current.loaded).toBe(false)
    expect(result.current.model).toEqual({ sessionId: "session-b", turns: [] })
    await waitFor(() => expect(result.current.model.turns.map((item) => item.id)).toEqual(["b-turn"]))

    // The new attachment starts after a-old ended. Run-scoped filtering used
    // to hide it here even though it remains part of session-a's history.
    act(() => rerender({ currentBinding: binding("run-a2", "session-a", 100) }))
    await waitFor(() =>
      expect(result.current.model.turns.map((item) => item.id)).toEqual(["a-old", "a-new"]),
    )
  })

  it("shows an empty loading generation while a resumed run replaces the current run", async () => {
    const sessionA: EngineTrace = {
      sessionId: "session-a",
      turns: [turn("a-turn", 10, 20)],
    }
    let resolveResume: ((trace: EngineTrace) => void) | undefined
    const resumedTrace = new Promise<EngineTrace>((resolve) => {
      resolveResume = resolve
    })
    fetchTrace.mockImplementation(async (_vendor, sessionId) => {
      if (sessionId === "session-a") return sessionA
      return await resumedTrace
    })

    const { result, rerender } = renderHook(
      ({ currentBinding, engineState }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState,
          binding: currentBinding,
        }),
      {
        initialProps: {
          currentBinding: binding("run-a", "session-a", 1),
          engineState: { taskId: "task-1", state: "idle", at: 0 },
        },
      },
    )

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.model.turns[0]?.id).toBe("a-turn")

    act(() =>
      rerender({
        currentBinding: binding("run-b", "session-b", 30),
        engineState: { taskId: "task-1", state: "running", at: 31 },
      }),
    )

    // The running activity overlay must not synthesize a turn over the loader,
    // and the previous session must not survive under the new run identity.
    expect(result.current.loaded).toBe(false)
    expect(result.current.model).toEqual({ sessionId: "session-b", turns: [] })

    await act(async () => {
      resolveResume?.({
        sessionId: "session-b",
        turns: [turn("b-turn", 30, 40)],
      })
    })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.model.turns[0]?.id).toBe("b-turn")
  })

  it("starts loading on a transient resume log before the selected session id is bound", async () => {
    const sessionA: EngineTrace = {
      sessionId: "session-a",
      turns: [turn("a-turn", 10, 20)],
    }
    fetchTrace.mockResolvedValue(sessionA)
    const pending: EngineSessionTransition = {
      taskId: "task-1",
      tabId: "tab-1",
      vendor: "codex",
      startSource: "resume",
      observedAt: 25,
    }

    const { result, rerender } = renderHook(
      ({ currentTransition }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState: undefined,
          binding: binding("run-a", "session-a", 1),
          transition: currentTransition,
        }),
      {
        initialProps: {
          currentTransition: undefined as EngineSessionTransition | undefined,
        },
      },
    )

    await waitFor(() => expect(result.current.model.turns[0]?.id).toBe("a-turn"))
    act(() => rerender({ currentTransition: pending }))
    expect(result.current.bindingState).toBe("pending")
    expect(result.current.loaded).toBe(false)
    expect(result.current.model).toEqual({ sessionId: "", turns: [] })

    act(() => rerender({ currentTransition: undefined }))
    expect(result.current.loaded).toBe(true)
    expect(result.current.model.turns[0]?.id).toBe("a-turn")
  })
})
