import { describe, expect, it } from "vitest"
import { type EngineOption, engineLabel } from "../src/lib/engines.ts"

/**
 * engineLabel maps a vendor id to its display label across the New Task,
 * Settings, and workspace-tab pickers — engine-owned UI data, so a missing
 * entry must degrade to the raw id, never crash or show "undefined".
 */

const LIST: EngineOption[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "my-engine", label: "My Engine" },
]

describe("engineLabel", () => {
  it("returns the label for a known id", () => {
    expect(engineLabel(LIST, "claude")).toBe("Claude")
    expect(engineLabel(LIST, "my-engine")).toBe("My Engine")
  })

  it("falls back to the raw id for an unknown id (custom engine before fetch)", () => {
    expect(engineLabel(LIST, "ghost")).toBe("ghost")
  })

  it("defaults to claude when no id is given", () => {
    expect(engineLabel(LIST, undefined)).toBe("claude")
    expect(engineLabel([], undefined)).toBe("claude")
  })

  it("falls back to the id even with an empty list", () => {
    expect(engineLabel([], "codex")).toBe("codex")
  })
})
