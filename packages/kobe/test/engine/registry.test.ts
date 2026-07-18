/**
 * Engine registry (engine/registry.ts) — the consolidation point for the
 * per-vendor conditionals that used to be scattered through
 * monitor/auto-title.ts, engine/hook-adapter.ts and the
 * three account detectors. These tests pin the registry's contract:
 *
 *  - known vendors resolve to REAL entries (the right detector, the right
 *    history reader, claude's hook adapter);
 *  - an unknown/custom vendor resolves to the documented EMPTY entry
 *    (no transcript store, no account detection, noop hooks) —
 *    the pre-registry behavior for custom engines, preserved on purpose
 *    so auto-title never mis-reads claude's transcripts for an unknown id.
 */

import { describe, expect, it } from "vitest"
import type { DetectDeps } from "../../src/engine/account-detect.ts"
import { EMPTY_HISTORY, engineEntry, getCapabilities } from "../../src/engine/registry.ts"

/** A DetectDeps with every binary found and no files/env, overridable per test. */
function deps(over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    readFile: () => null,
    env: () => undefined,
    home: () => "/home/u",
    findClaudeBinary: async () => "/bin/claude",
    findCodexBinary: async () => "/bin/codex",
    findCopilotBinary: async () => "/bin/copilot",
    findKimiBinary: async () => "/bin/kimi",
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
    // Claude is the only engine with wired activity hooks.
    expect(entry.createHookAdapter().supportsHooks()).toBe(true)
    expect(entry.history).not.toBe(EMPTY_HISTORY)
    // Claude persists turn-completion markers the ChatTab detector can read.
    const detector = entry.createTurnDetector()
    expect(detector.vendor).toBe("claude")
    expect(detector.supportsCompletionMarkers()).toBe(true)
    // Claude is the only engine declaring user-slash directories — the TUI
    // gates its `.claude/{commands,skills}/` loader on this, not a vendor string.
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
      // Codex has a wired hook mechanism (~/.codex/hooks.json); copilot doesn't yet.
      expect(hooks.supportsHooks()).toBe(vendor === "codex")
      // Real history readers — not the custom-engine empty one.
      expect(entry.history).not.toBe(EMPTY_HISTORY)
      // Codex reads `turn.completed` rollout markers; copilot has none yet.
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
    expect(entry.terminalTitle).toEqual({
      ownsStatus: true,
      launchArgs: ["-c", 'tui.terminal_title=["activity","thread-title"]'],
    })
  })

  it("routes detectAccount to the vendor's own detector (claude oauth)", async () => {
    const status = await engineEntry("claude").detectAccount(
      deps({
        // ~/.claude.json shape — only the claude detector understands this.
        readFile: () => JSON.stringify({ oauthAccount: { emailAddress: "a@b.com" } }),
      }),
    )
    expect(status.account.kind).toBe("oauth")
  })

  it("routes detectAccount to the vendor's own detector (codex api key)", async () => {
    const status = await engineEntry("codex").detectAccount(
      deps({
        // ~/.codex/auth.json shape — only the codex detector understands this.
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
    // copilot + custom must NOT borrow claude's model catalog / permission modes.
    expect(getCapabilities("copilot")).toBeUndefined()
    expect(getCapabilities("aider")).toBeUndefined()
  })
})

describe("engineEntry — custom (user-registered) vendors", () => {
  it("returns the documented empty entry", async () => {
    const entry = engineEntry("aider")
    expect(entry.vendor).toBe("aider")
    expect(entry.builtin).toBe(false)
    // Labels as its id; launches a bare binary named after the id (the
    // real command lives in the user's engineCommand.<id> override).
    expect(entry.displayName).toBe("aider")
    expect(entry.defaultCommand).toEqual(["aider"])
    // No transcript store: auto-title keeps the placeholder instead of
    // mis-reading another vendor's files.
    expect(await entry.history.listSessionIdsForWorktree("/some/worktree")).toEqual([])
    expect(await entry.history.readHistory("some-session")).toEqual([])
    // No transcript store → the Ops activity poll always sees 0 ("no
    // activity seen") instead of watching another vendor's files.
    expect(await entry.history.latestTranscriptMtimeForWorktree("/some/worktree")).toBe(0)
    // No persisted completion markers either — the ChatTab detector reports
    // "unknown" support rather than borrowing claude's transcripts.
    const detector = entry.createTurnDetector()
    expect(detector.vendor).toBe("aider")
    expect(detector.supportsCompletionMarkers()).toBe(false)
    expect(await detector.latestCompletion("/some/worktree")).toBeNull()
    // No account detection, no hooks.
    const status = await entry.detectAccount()
    expect(status.account).toEqual({ kind: "none" })
    expect(status.binary.found).toBe(false)
    expect(entry.createHookAdapter().supportsHooks()).toBe(false)
  })
})
