// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineTrace, TraceTurn } from "../src/lib/trace.ts"
import type {
  EngineSessionBinding,
  EngineSessionTransition,
} from "../src/lib/types.ts"

const { subscribeTrace } = vi.hoisted(() => ({
  subscribeTrace: vi.fn(),
}))

vi.mock("../src/lib/trace.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/trace.ts")>()
  return {
    ...actual,
    subscribeTrace,
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
    subscribeTrace.mockReset()
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
    subscribeTrace.mockImplementation((_vendor, sessionId, onTrace) => {
      onTrace(sessionId === "session-a" ? sessionA : sessionB)
      return () => undefined
    })

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
    subscribeTrace.mockImplementation((_vendor, sessionId, onTrace) => {
      if (sessionId === "session-a") onTrace(sessionA)
      else resolveResume = onTrace
      return () => undefined
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
    subscribeTrace.mockImplementation((_vendor, _sessionId, onTrace) => {
      onTrace(sessionA)
      return () => undefined
    })
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

  it("masks the previous trace when a new engine process has no session id yet", async () => {
    subscribeTrace.mockImplementation((_vendor, _sessionId, onTrace) => {
      onTrace({ sessionId: "session-a", turns: [turn("old-turn", 10, 20)] })
      return () => undefined
    })
    const { result, rerender } = renderHook(
      ({ currentBinding }: { currentBinding: EngineSessionBinding }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState: undefined,
          binding: currentBinding,
        }),
      { initialProps: { currentBinding: binding("old-run", "session-a", 1) } },
    )
    await waitFor(() => expect(result.current.model.turns[0]?.id).toBe("old-turn"))

    act(() =>
      rerender({
        currentBinding: {
          ...binding("empty-run", "session-a", 30),
          sessionId: null,
          state: "pending",
          source: "spawn",
          startSource: undefined,
        },
      }),
    )
    expect(result.current.bindingState).toBe("empty")
    expect(result.current.model).toEqual({ sessionId: "", turns: [] })
  })

  it("settles loading from the SSE error path without a parallel GET", async () => {
    subscribeTrace.mockImplementation((_vendor, _sessionId, _onTrace, onError) => {
      onError?.("trace unavailable")
      return () => undefined
    })
    const { result } = renderHook(() =>
      useTimelineData({
        taskId: "task-1",
        vendor: "codex",
        engineState: undefined,
        binding: binding("run-a", "session-a", 1),
      }),
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.error).toBe("trace unavailable")
  })

  it("keeps the newest SSE snapshot when updates race inside resume loading", async () => {
    let onResume: ((trace: EngineTrace) => void) | undefined
    subscribeTrace.mockImplementation((_vendor, sessionId, onTrace) => {
      if (sessionId === "session-a") onTrace({ sessionId, turns: [turn("a", 1, 2)] })
      else onResume = onTrace
      return () => undefined
    })
    const { result, rerender } = renderHook(
      ({ currentBinding }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState: undefined,
          binding: currentBinding,
        }),
      { initialProps: { currentBinding: binding("run-a", "session-a", 1) } },
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    act(() => rerender({ currentBinding: binding("run-b", "session-b", 3) }))
    act(() => {
      onResume?.({ sessionId: "session-b", turns: [turn("older", 3, 4)] })
      onResume?.({ sessionId: "session-b", turns: [turn("newest", 5, 6)] })
    })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.model.turns.map((item) => item.id)).toEqual(["newest"])
  })

  it("ignores a stale snapshot delivered after switching sessions", async () => {
    const listeners = new Map<string, (trace: EngineTrace) => void>()
    const unsubscribers = new Map<string, ReturnType<typeof vi.fn>>()
    subscribeTrace.mockImplementation((_vendor, sessionId, onTrace) => {
      listeners.set(sessionId, onTrace)
      const unsubscribe = vi.fn()
      unsubscribers.set(sessionId, unsubscribe)
      return unsubscribe
    })
    const { result, rerender } = renderHook(
      ({ currentBinding }) =>
        useTimelineData({
          taskId: "task-1",
          vendor: "codex",
          engineState: undefined,
          binding: currentBinding,
        }),
      { initialProps: { currentBinding: binding("run-a", "session-a", 1) } },
    )
    act(() => listeners.get("session-a")?.({ sessionId: "session-a", turns: [turn("a", 1, 2)] }))
    await waitFor(() => expect(result.current.loaded).toBe(true))

    act(() => rerender({ currentBinding: binding("run-b", "session-b", 3) }))
    expect(unsubscribers.get("session-a")).toHaveBeenCalledOnce()
    act(() => {
      listeners.get("session-b")?.({ sessionId: "session-b", turns: [turn("b", 3, 4)] })
      listeners.get("session-a")?.({ sessionId: "session-a", turns: [turn("stale-a", 5, 6)] })
    })

    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.model).toEqual({ sessionId: "session-b", turns: [turn("b", 3, 4)] })
  })

  it("clears a settled stream error when a later full snapshot recovers", async () => {
    let onTrace: ((trace: EngineTrace) => void) | undefined
    let onError: ((message: string) => void) | undefined
    subscribeTrace.mockImplementation((_vendor, _sessionId, traceListener, errorListener) => {
      onTrace = traceListener
      onError = errorListener
      return () => undefined
    })
    const { result } = renderHook(() =>
      useTimelineData({
        taskId: "task-1",
        vendor: "codex",
        engineState: undefined,
        binding: binding("run-a", "session-a", 1),
      }),
    )
    act(() => onError?.("temporary failure"))
    await waitFor(() => expect(result.current.error).toBe("temporary failure"))

    act(() => onTrace?.({ sessionId: "session-a", turns: [turn("recovered", 2, 3)] }))
    await waitFor(() => expect(result.current.error).toBeNull())
    expect(result.current.model.turns.map((item) => item.id)).toEqual(["recovered"])
  })
})
