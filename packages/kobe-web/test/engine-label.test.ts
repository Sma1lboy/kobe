import { describe, expect, it } from "vitest"
import type { EngineOption } from "../src/lib/engines.ts"
import { engineLabel } from "../src/lib/vendor.ts"

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

  it("defaults to the registry's claude label when no id is given", () => {
    // Unset coalesces to "claude" and resolves through the registry — so it
    // matches an explicit vendor:"claude" exactly (same label, same override).
    expect(engineLabel(LIST, undefined)).toBe("Claude")
    expect(engineLabel(LIST, undefined)).toBe(engineLabel(LIST, "claude"))
    // With no registry yet, it degrades to the raw "claude" id.
    expect(engineLabel([], undefined)).toBe("claude")
  })

  it("falls back to the id even with an empty list", () => {
    expect(engineLabel([], "codex")).toBe("codex")
  })
})
