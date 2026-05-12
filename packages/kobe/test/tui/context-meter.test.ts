import { describe, expect, it } from "vitest"
import {
  contextWindowTokensForModel,
  deriveUsageMetricsFromHistory,
  formatContextUsageCompact,
  formatTotalSpeed,
  totalContextTokens,
} from "../../src/tui/panes/chat/context-meter.ts"
import type { Message } from "../../src/types/engine.ts"

describe("context-meter", () => {
  it("totals prompt-side tokens only (excludes output)", () => {
    expect(
      totalContextTokens({
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 100,
      }),
    ).toBe(3100)
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
    expect(label).toBe("35% · 70k/200k")
  })

  it("appends total speed when available", () => {
    const label = formatContextUsageCompact(
      {
        input_tokens: 20_000,
        output_tokens: 2000,
        cache_read_input_tokens: 50_000,
        total_speed_tokens_per_second: 366.666,
      },
      "claude-sonnet-4-6",
    )
    expect(label).toBe("35% · 70k/200k · 366.7 t/s")
  })

  it("formats high total speed with k suffix", () => {
    expect(formatTotalSpeed(1234.56)).toBe("1.2k t/s")
  })

  it("derives latest context usage and session-average total speed from history", () => {
    const past: Message[] = [
      { role: "user", content: "one", timestamp: "2026-05-09T00:00:00.000Z", sessionId: "s" },
      {
        role: "assistant",
        content: "ok",
        timestamp: "2026-05-09T00:00:02.000Z",
        sessionId: "s",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      { role: "user", content: "two", timestamp: "2026-05-09T00:00:10.000Z", sessionId: "s" },
      {
        role: "assistant",
        content: "ok again",
        timestamp: "2026-05-09T00:00:14.000Z",
        sessionId: "s",
        usage: { input_tokens: 600, output_tokens: 200, cache_read_input_tokens: 100 },
      },
    ]

    expect(deriveUsageMetricsFromHistory(past)).toEqual({
      input_tokens: 600,
      output_tokens: 200,
      cache_read_input_tokens: 100,
      total_speed_tokens_per_second: 158.33333333333334,
    })
  })
})
