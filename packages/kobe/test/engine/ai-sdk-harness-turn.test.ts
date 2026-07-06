import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// --- harness module mocks (hoisted) --------------------------------------
// Controllable stand-ins for the locally-installed harness runtime so we can
// exercise startAiSdkTurn's setup/error/rebuild paths without a real CLI.
const state: {
  ctorCalls: Array<{ harness: unknown }>
  claudeCalls: Array<{ model?: string }>
  createSessionCalls: unknown[]
  streamCalls: unknown[]
  createSession: (opts?: unknown) => Promise<{
    sessionId?: string
    isResume?: boolean
    stop?: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
  }>
  stream: (args: unknown) => Promise<{ toUIMessageStream: () => unknown }>
  readStream: () => AsyncIterable<unknown>
} = {
  ctorCalls: [],
  claudeCalls: [],
  createSessionCalls: [],
  streamCalls: [],
  createSession: async () => ({
    sessionId: "session-default",
    stop: vi.fn().mockResolvedValue({
      type: "resume-session",
      harnessId: "test-harness",
      specificationVersion: "harness-v1",
      data: {},
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  }),
  stream: async () => ({ toUIMessageStream: () => ({}) }),
  readStream: async function* () {
    yield { role: "assistant", parts: [] }
  },
}

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(opts: { harness: unknown }) {
      state.ctorCalls.push(opts)
    }
    createSession(opts?: unknown) {
      state.createSessionCalls.push(opts)
      return state.createSession(opts)
    }
    stream(args: unknown) {
      state.streamCalls.push(args)
      return state.stream(args)
    }
  },
}))
vi.mock("@ai-sdk/harness-claude-code", () => ({
  createClaudeCode: (opts: { model?: string }) => {
    state.claudeCalls.push(opts)
    if (opts.model === "bad") throw new Error("invalid model id")
    return { _claude: opts }
  },
}))
vi.mock("@ai-sdk/harness-codex", () => ({ createCodex: (opts: unknown) => ({ _codex: opts }) }))
vi.mock("ai", () => ({ readUIMessageStream: () => state.readStream() }))

import {
  aiSdkRuntimeKey,
  buildPromptWithHistory,
  codexReasoningEffort,
  disposeAiSdkRuntime,
  historyTokenBudgetForContextWindow,
  resolveAiSdkHarnessVendor,
  startAiSdkTurn,
} from "../../src/engine/ai-sdk/harness-turn"

describe("AI SDK harness turn helpers", () => {
  it("routes Codex tasks to the Codex harness and falls back to Claude otherwise", () => {
    expect(resolveAiSdkHarnessVendor("codex")).toBe("codex")
    expect(resolveAiSdkHarnessVendor("claude")).toBe("claude")
    expect(resolveAiSdkHarnessVendor("copilot")).toBe("claude")
    expect(resolveAiSdkHarnessVendor(undefined)).toBe("claude")
  })

  it("keys runtimes by vendor and worktree", () => {
    expect(aiSdkRuntimeKey("claude", "/repo/wt")).toBe("claude:/repo/wt")
    expect(aiSdkRuntimeKey("codex", "/repo/wt")).toBe("codex:/repo/wt")
    expect(aiSdkRuntimeKey("codex", "/repo/wt", "router")).toBe("router:codex:/repo/wt")
  })

  it("passes only Codex harness-supported reasoning efforts", () => {
    expect(codexReasoningEffort("low")).toBe("low")
    expect(codexReasoningEffort("medium")).toBe("medium")
    expect(codexReasoningEffort("high")).toBe("high")
    expect(codexReasoningEffort("xhigh")).toBeUndefined()
    expect(codexReasoningEffort("none")).toBeUndefined()
    expect(codexReasoningEffort(undefined)).toBeUndefined()
  })

  it("leaves prompts unchanged when no Kobe history is supplied", () => {
    expect(buildPromptWithHistory("what changed?", [])).toBe("what changed?")
    expect(buildPromptWithHistory("what changed?")).toBe("what changed?")
  })

  it("serializes prior Kobe history before the new prompt", () => {
    const prompt = buildPromptWithHistory("continue", [
      { role: "user", text: "first request" },
      { role: "assistant", text: "first answer" },
    ])
    expect(prompt).toContain("Previous Kobe conversation:")
    expect(prompt).toContain("User: first request")
    expect(prompt).toContain("Assistant: first answer")
    expect(prompt).toContain("Current user prompt:\ncontinue")
  })

  it("uses caller-supplied token budget instead of a tiny fixed history cap", () => {
    const older = "older ".repeat(3000)
    const newer = "newer ".repeat(3000)
    const prompt = buildPromptWithHistory(
      "continue",
      [
        { role: "user", text: older },
        { role: "assistant", text: newer },
      ],
      { historyTokenBudget: 10_000 },
    )
    expect(prompt).toContain("User: older older older")
    expect(prompt).toContain("Assistant: newer newer newer")
  })

  it("derives a large history budget from the model context window", () => {
    expect(historyTokenBudgetForContextWindow(200_000)).toBeGreaterThan(100_000)
    expect(historyTokenBudgetForContextWindow(1_000_000)).toBeGreaterThan(700_000)
    expect(historyTokenBudgetForContextWindow(0)).toBeGreaterThan(100_000)
  })
})

describe("startAiSdkTurn", () => {
  let wt = 0
  let home: string | undefined
  let previousHomeEnv: string | undefined
  const nextWorktree = () => `/repo/wt-${++wt}`
  const opened: string[] = []
  const run = (worktree: string, extra: Record<string, unknown> = {}) => {
    opened.push(worktree)
    return startAiSdkTurn({ worktree, prompt: "hi", onUpdate: () => {}, ...extra })
  }

  beforeEach(() => {
    previousHomeEnv = process.env.KOBE_HOME_DIR
    home = mkdtempSync(join(tmpdir(), "kobe-ai-sdk-home-"))
    process.env.KOBE_HOME_DIR = home
    state.ctorCalls = []
    state.claudeCalls = []
    state.createSessionCalls = []
    state.streamCalls = []
    state.createSession = async () => ({
      sessionId: "session-default",
      stop: vi.fn().mockResolvedValue({
        type: "resume-session",
        harnessId: "test-harness",
        specificationVersion: "harness-v1",
        data: {},
      }),
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    state.stream = async () => ({ toUIMessageStream: () => ({}) })
    state.readStream = async function* () {
      yield { role: "assistant", parts: [] }
    }
  })
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((w) => disposeAiSdkRuntime(w)))
    if (previousHomeEnv === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    else process.env.KOBE_HOME_DIR = previousHomeEnv
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
    previousHomeEnv = undefined
  })

  it("completes a normal turn, forwarding stream snapshots to onUpdate", async () => {
    const worktree = nextWorktree()
    opened.push(worktree)
    const updates: unknown[] = []
    const res = await startAiSdkTurn({ worktree, prompt: "hi", onUpdate: (m) => updates.push(m) }).done
    expect(res).toEqual({})
    expect(updates.length).toBeGreaterThan(0)
  })

  it("routes a synchronous setup failure (bad model) into the turn error, not an unhandled rejection", async () => {
    const res = await run(nextWorktree(), { model: "bad" }).done
    expect(res.error).toBeDefined()
    expect((res.error as { message: string }).message).toContain("invalid model id")
  })

  it("surfaces a mid-stream failure as the turn error", async () => {
    // An async iterable whose first pull rejects — models a stream failure.
    state.readStream = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("mid-stream boom")) }),
    })
    const res = await run(nextWorktree()).done
    expect((res.error as { message: string }).message).toContain("mid-stream boom")
  })

  it("rejects a second concurrent turn on the same runtime as busy", async () => {
    const worktree = nextWorktree()
    let release!: () => void
    state.createSession = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            sessionId: "busy-session",
            stop: vi.fn().mockResolvedValue({
              type: "resume-session",
              harnessId: "test-harness",
              specificationVersion: "harness-v1",
              data: {},
            }),
            destroy: vi.fn().mockResolvedValue(undefined),
          })
      })
    const first = run(worktree) // suspends on createSession -> busy = true
    const second = await run(worktree).done
    expect(second).toEqual({ error: { code: "runtimeBusy" } })
    release()
    await first.done
  })

  it("rebuilds the runtime and resumes the same provider session when the model changes", async () => {
    const worktree = nextWorktree()
    const resumeState = {
      type: "resume-session",
      harnessId: "test-harness",
      specificationVersion: "harness-v1",
      data: { bridge: "kept" },
    }
    const stop = vi.fn().mockResolvedValue(resumeState)
    state.createSession = async (opts?: unknown) => ({
      sessionId: (opts as { sessionId?: string } | undefined)?.sessionId ?? "same-session",
      isResume: Boolean((opts as { resumeFrom?: unknown } | undefined)?.resumeFrom),
      stop,
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    await run(worktree, { model: "model-a" }).done
    expect(state.ctorCalls).toHaveLength(1)
    expect(state.claudeCalls.at(-1)).toEqual({ model: "model-a" })

    await run(worktree, { model: "model-b" }).done
    expect(state.ctorCalls).toHaveLength(2)
    expect(state.claudeCalls.at(-1)).toEqual({ model: "model-b" })
    expect(stop).toHaveBeenCalled()
    expect(state.createSessionCalls.at(-1)).toEqual({
      sessionId: "same-session",
      resumeFrom: resumeState,
    })
  })

  it("reuses the runtime (no rebuild) when the model is unchanged", async () => {
    const worktree = nextWorktree()
    await run(worktree, { model: "model-a" }).done
    await run(worktree, { model: "model-a" }).done
    expect(state.ctorCalls).toHaveLength(1)
  })

  it("does not replay Kobe history when a model rebuild resumes the provider session", async () => {
    const worktree = nextWorktree()
    const resumeState = {
      type: "resume-session",
      harnessId: "test-harness",
      specificationVersion: "harness-v1",
      data: { thread: "still-here" },
    }
    state.createSession = async (opts?: unknown) => ({
      sessionId: (opts as { sessionId?: string } | undefined)?.sessionId ?? "resume-session-id",
      stop: vi.fn().mockResolvedValue(resumeState),
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    await run(worktree, {
      model: "model-a",
      prompt: "second request",
      history: [
        { role: "user", text: "first request" },
        { role: "assistant", text: "first answer" },
      ],
    }).done

    await run(worktree, {
      model: "model-b",
      prompt: "third request",
      history: [
        { role: "user", text: "first request" },
        { role: "assistant", text: "first answer" },
        { role: "user", text: "second request" },
        { role: "assistant", text: "second answer" },
      ],
    }).done

    expect(state.ctorCalls).toHaveLength(2)
    const secondStream = state.streamCalls.at(-1) as { prompt?: string } | undefined
    expect(secondStream?.prompt).toBe("third request")
  })

  it("replays bounded Kobe history only when provider session resume fails", async () => {
    const worktree = nextWorktree()
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const resumeState = {
      type: "resume-session",
      harnessId: "test-harness",
      specificationVersion: "harness-v1",
      data: { thread: "stale" },
    }
    const firstStop = vi.fn().mockResolvedValue(resumeState)
    let resumedOnce = false
    state.createSession = async (opts?: unknown) => {
      const resumeFrom = (opts as { resumeFrom?: unknown } | undefined)?.resumeFrom
      if (resumeFrom) {
        resumedOnce = true
        throw new Error("stale resume state")
      }
      return {
        sessionId: "fallback-session",
        stop: firstStop,
        destroy: vi.fn().mockResolvedValue(undefined),
      }
    }

    try {
      await run(worktree, { model: "model-a", prompt: "first request" }).done
      await disposeAiSdkRuntime(worktree)
      const res = await run(worktree, {
        model: "model-a",
        prompt: "second request",
        history: [
          { role: "user", text: "first request" },
          { role: "assistant", text: "first answer" },
        ],
      }).done

      expect(res).toEqual({})
      expect(resumedOnce).toBe(true)
      const secondStream = state.streamCalls.at(-1) as { prompt?: string } | undefined
      expect(secondStream?.prompt).toContain("Previous Kobe conversation:")
      expect(secondStream?.prompt).toContain("Assistant: first answer")
      expect(secondStream?.prompt).toContain("Current user prompt:\nsecond request")
    } finally {
      consoleError.mockRestore()
    }
  })

  it("persists a stopped provider session on dispose and resumes it next time", async () => {
    const worktree = nextWorktree()
    const resumeState = {
      type: "resume-session",
      harnessId: "test-harness",
      specificationVersion: "harness-v1",
      data: { thread: "parked" },
    }
    const stop = vi.fn().mockResolvedValue(resumeState)
    state.createSession = async (opts?: unknown) => ({
      sessionId: (opts as { sessionId?: string } | undefined)?.sessionId ?? "parked-session",
      isResume: Boolean((opts as { resumeFrom?: unknown } | undefined)?.resumeFrom),
      stop,
      destroy: vi.fn().mockResolvedValue(undefined),
    })

    await run(worktree, { model: "model-a" }).done
    await disposeAiSdkRuntime(worktree)
    await run(worktree, { model: "model-a" }).done

    expect(stop).toHaveBeenCalled()
    expect(state.createSessionCalls.at(-1)).toEqual({
      sessionId: "parked-session",
      resumeFrom: resumeState,
    })
  })
})
