import { describe, expect, it } from "vitest"
import type { DetectDeps } from "../../src/engine/account-detect.ts"
import { EMPTY_HISTORY, engineEntry, getCapabilities } from "../../src/engine/registry.ts"

function deps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    readFile: () => null,
    env: () => undefined,
    home: () => "/home/u",
    findClaudeBinary: async () => "/bin/claude",
    findCodexBinary: async () => "/bin/codex",
    findCopilotBinary: async () => "/bin/copilot",
    ...over,
  }
}

describe("engineEntry — built-in vendors", () => {
  it("resolves claude with display name, default command and real hooks", () => {
    const entry = engineEntry("claude")
    expect(entry.vendor).toBe("claude")
    expect(entry.builtin).toBe(true)
    expect(entry.displayName).toBe("Claude")
    expect(entry.defaultCommand).toEqual(["claude"])
    expect(entry.createHookAdapter().supportsHooks()).toBe(true)
    expect(entry.history).not.toBe(EMPTY_HISTORY)
    const detector = entry.createTurnDetector()
    expect(detector.vendor).toBe("claude")
    expect(detector.supportsCompletionMarkers()).toBe(true)
  })

  it("resolves codex/copilot with their identity, history, and hook wiring", () => {
    for (const [vendor, label] of [
      ["codex", "Codex"],
      ["copilot", "Copilot"],
    ] as const) {
      const entry = engineEntry(vendor)
      expect(entry.vendor).toBe(vendor)
      expect(entry.builtin).toBe(true)
      expect(entry.displayName).toBe(label)
      expect(entry.defaultCommand).toEqual([vendor])
      const hooks = entry.createHookAdapter()
      expect(hooks.vendor).toBe(vendor)
      expect(hooks.supportsHooks()).toBe(vendor === "codex")
      expect(entry.history).not.toBe(EMPTY_HISTORY)
      const detector = entry.createTurnDetector()
      expect(detector.vendor).toBe(vendor)
      expect(detector.supportsCompletionMarkers()).toBe(vendor === "codex")
    }
  })

  it("exposes Codex identity and its harness default model through capabilities", () => {
    const entry = engineEntry("codex")
    expect(entry.identity?.inputPlaceholder).toBe("Ask Codex…")
    expect(entry.capabilities?.defaultModelId()).toBe("gpt-5.3-codex")
    expect(entry.capabilities?.permissionModes).toEqual([])
  })

  it("routes detectAccount to the vendor's own detector (claude oauth)", async () => {
    const status = await engineEntry("claude").detectAccount(
      deps({
        readFile: () => JSON.stringify({ oauthAccount: { emailAddress: "a@b.com" } }),
      }),
    )
    expect(status.account.kind).toBe("oauth")
  })

  it("routes detectAccount to the vendor's own detector (codex api key)", async () => {
    const status = await engineEntry("codex").detectAccount(
      deps({
        readFile: () => JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
      }),
    )
    expect(status.account.kind).toBe("apikey")
  })
})

describe("getCapabilities", () => {
  it("returns the engine's own capabilities for vendors that have them", () => {
    expect(getCapabilities("claude")?.vendorId).toBe("claude")
    expect(getCapabilities("codex")?.vendorId).toBe("codex")
  })

  it("returns undefined for engines with no capabilities (no claude fallback)", () => {
    expect(getCapabilities("copilot")).toBeUndefined()
    expect(getCapabilities("aider")).toBeUndefined()
  })
})

describe("engineEntry — custom (user-registered) vendors", () => {
  it("returns the documented empty entry", async () => {
    const entry = engineEntry("aider")
    expect(entry.vendor).toBe("aider")
    expect(entry.builtin).toBe(false)
    expect(entry.displayName).toBe("aider")
    expect(entry.defaultCommand).toEqual(["aider"])
    expect(await entry.history.listSessionIdsForWorktree("/some/worktree")).toEqual([])
    expect(await entry.history.readHistory("some-session")).toEqual([])
    expect(await entry.history.latestTranscriptMtimeForWorktree("/some/worktree")).toBe(0)
    const detector = entry.createTurnDetector()
    expect(detector.vendor).toBe("aider")
    expect(detector.supportsCompletionMarkers()).toBe(false)
    expect(await detector.latestCompletion("/some/worktree")).toBeNull()
    const status = await entry.detectAccount()
    expect(status.account).toEqual({ kind: "none" })
    expect(status.binary.found).toBe(false)
    expect(entry.createHookAdapter().supportsHooks()).toBe(false)
  })
})
