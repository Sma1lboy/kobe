import { describe, expect, it } from "vitest"
import { capabilitiesForModelId } from "../../src/engine/registry.ts"
import { formatContextUsageCompact, totalContextTokens } from "../../src/tui/panes/chat/context-meter.ts"

function contextWindowTokensForModel(id: string): number {
  return capabilitiesForModelId(id).contextWindowFor(id)
}

describe("context-meter", () => {
  it("totals billed context fields", () => {
    expect(
      totalContextTokens({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 100,
      }),
    ).toBe(3600)
  })

  it("maps [1m] models to 1M window", () => {
    expect(contextWindowTokensForModel("claude-opus-4-7[1m]")).toBe(1_000_000)
    expect(contextWindowTokensForModel("claude-sonnet-4-6")).toBe(200_000)
  })

  it("formats compact label", () => {
    const label = formatContextUsageCompact(
      { input_tokens: 20_000, output_tokens: 2000, cache_read_input_tokens: 50_000 },
      "claude-sonnet-4-6",
    )
    expect(label).toBe("36% · 72k/200k")
  })
})
