import { afterEach, describe, expect, test } from "vitest"
import { ClaudeCodeLocal } from "../../src/engine/claude-code-local/index.ts"
import { buildDefaultEngines } from "../../src/engine/default-engines.ts"
import { InteractiveClaudeEngine } from "../../src/engine/interactive-claude/index.ts"

describe("buildDefaultEngines", () => {
  afterEach(() => {
    process.env.KOBE_INTERACTIVE_CLAUDE = undefined
  })

  test("registers every local engine used by daemon and TUI startup", () => {
    const engines = buildDefaultEngines()

    expect(engines.claude?.capabilities.vendorId).toBe("claude")
    expect(engines.codex?.capabilities.vendorId).toBe("codex")
    expect(engines.gemini?.capabilities.vendorId).toBe("gemini")
  })

  test("claude slot is ClaudeCodeLocal by default", () => {
    expect(buildDefaultEngines().claude).toBeInstanceOf(ClaudeCodeLocal)
  })

  test("KOB-208: KOBE_INTERACTIVE_CLAUDE=1 opts the claude slot into InteractiveClaudeEngine", () => {
    process.env.KOBE_INTERACTIVE_CLAUDE = "1"
    const engines = buildDefaultEngines()
    expect(engines.claude).toBeInstanceOf(InteractiveClaudeEngine)
    // Still a claude-vendor engine — capabilities/identity are unchanged.
    expect(engines.claude?.capabilities.vendorId).toBe("claude")
  })
})
