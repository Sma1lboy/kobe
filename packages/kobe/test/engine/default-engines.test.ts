import { describe, expect, test } from "vitest"
import { buildDefaultEngines } from "../../src/engine/default-engines.ts"

describe("buildDefaultEngines", () => {
  test("registers every local engine used by daemon and TUI startup", () => {
    const engines = buildDefaultEngines()

    expect(engines.claude?.capabilities.vendorId).toBe("claude")
    expect(engines.codex?.capabilities.vendorId).toBe("codex")
    expect(engines.gemini?.capabilities.vendorId).toBe("gemini")
  })
})
