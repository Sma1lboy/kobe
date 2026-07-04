import { describe, expect, it } from "vitest"
import { aiSdkRuntimeKey, codexReasoningEffort, resolveAiSdkHarnessVendor } from "../../src/engine/ai-sdk/harness-turn"

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
