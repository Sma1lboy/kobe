import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// --- harness module mocks (hoisted) --------------------------------------
// Controllable stand-ins for the locally-installed harness runtime so we can
// exercise startAiSdkTurn's setup/error/rebuild paths without a real CLI.
const state: {
  ctorCalls: Array<{ harness: unknown }>
  claudeCalls: Array<{ model?: string }>
  createSession: () => Promise<{ destroy: ReturnType<typeof vi.fn> }>
  stream: (args: unknown) => Promise<{ toUIMessageStream: () => unknown }>
  readStream: () => AsyncIterable<unknown>
} = {
  ctorCalls: [],
  claudeCalls: [],
  createSession: async () => ({ destroy: vi.fn().mockResolvedValue(undefined) }),
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
    createSession() {
      return state.createSession()
    }
    stream(args: unknown) {
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
  codexReasoningEffort,
  disposeAiSdkRuntime,
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
  })

  it("passes only Codex harness-supported reasoning efforts", () => {
    expect(codexReasoningEffort("low")).toBe("low")
    expect(codexReasoningEffort("medium")).toBe("medium")
    expect(codexReasoningEffort("high")).toBe("high")
    expect(codexReasoningEffort("xhigh")).toBeUndefined()
    expect(codexReasoningEffort("none")).toBeUndefined()
    expect(codexReasoningEffort(undefined)).toBeUndefined()
  })
})

describe("startAiSdkTurn", () => {
  let wt = 0
  const nextWorktree = () => `/repo/wt-${++wt}`
  const opened: string[] = []
  const run = (worktree: string, extra: Record<string, unknown> = {}) => {
    opened.push(worktree)
    return startAiSdkTurn({ worktree, prompt: "hi", onUpdate: () => {}, ...extra })
  }

  beforeEach(() => {
    state.ctorCalls = []
    state.claudeCalls = []
    state.createSession = async () => ({ destroy: vi.fn().mockResolvedValue(undefined) })
    state.stream = async () => ({ toUIMessageStream: () => ({}) })
    state.readStream = async function* () {
      yield { role: "assistant", parts: [] }
    }
  })
  afterEach(() => {
    for (const w of opened.splice(0)) disposeAiSdkRuntime(w)
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
        release = () => resolve({ destroy: vi.fn().mockResolvedValue(undefined) })
      })
    const first = run(worktree) // suspends on createSession -> busy = true
    const second = await run(worktree).done
    expect(second).toEqual({ error: { code: "runtimeBusy" } })
    release()
    await first.done
  })

  it("rebuilds the runtime (new agent, old session disposed) when the model changes", async () => {
    const worktree = nextWorktree()
    const destroy = vi.fn().mockResolvedValue(undefined)
    state.createSession = async () => ({ destroy })
    await run(worktree, { model: "model-a" }).done
    expect(state.ctorCalls).toHaveLength(1)
    expect(state.claudeCalls.at(-1)).toEqual({ model: "model-a" })

    await run(worktree, { model: "model-b" }).done
    expect(state.ctorCalls).toHaveLength(2)
    expect(state.claudeCalls.at(-1)).toEqual({ model: "model-b" })
    expect(destroy).toHaveBeenCalled()
  })

  it("reuses the runtime (no rebuild) when the model is unchanged", async () => {
    const worktree = nextWorktree()
    await run(worktree, { model: "model-a" }).done
    await run(worktree, { model: "model-a" }).done
    expect(state.ctorCalls).toHaveLength(1)
  })
})
