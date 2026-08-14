import { describe, expect, it } from "vitest"
import {
  formatTokens,
  type HistoryMessage,
  summarizeUsage,
} from "../src/lib/history.ts"

/**
 * The transcript header shows session in/out totals + a live context estimate
 * derived from per-message usage (ccstatusline's pattern: context = the LAST
 * turn's full prompt = input + cache read + cache creation). Lock the math.
 */

function msg(usage?: HistoryMessage["usage"]): HistoryMessage {
  return { role: "assistant", blocks: [], timestamp: "", sessionId: "s", usage }
}

describe("summarizeUsage", () => {
  it("sums input/output across turns, context = last turn's full prompt", () => {
    const out = summarizeUsage([
      msg({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }),
      msg({
        input_tokens: 200,
        output_tokens: 40,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 50,
      }),
    ])
    expect(out.inputTokens).toBe(300) // 100 + 200
    expect(out.outputTokens).toBe(60) // 20 + 40
    // context = last turn only: 200 + 1000 + 50
    expect(out.contextTokens).toBe(1250)
  })

  it("ignores messages with no usage and returns zeros for none", () => {
    expect(summarizeUsage([msg(), msg()])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
    })
    expect(summarizeUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      contextTokens: 0,
    })
  })

  it("treats missing cache fields as zero", () => {
    const out = summarizeUsage([msg({ input_tokens: 42, output_tokens: 7 })])
    expect(out.contextTokens).toBe(42)
  })
})

describe("formatTokens", () => {
  it("formats with k/m suffixes", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(999)).toBe("999")
    expect(formatTokens(1_500)).toBe("1.5k")
    expect(formatTokens(42_000)).toBe("42.0k")
    expect(formatTokens(2_300_000)).toBe("2.3m")
  })

  it("switches suffix at the EXACT threshold (>=, not >)", () => {
    // The boundary is the bit a `>` refactor would silently break: 999 stays
    // raw, 1000 is already "1.0k", and 1_000_000 is already "1.0m".
    expect(formatTokens(1_000)).toBe("1.0k")
    expect(formatTokens(1_000_000)).toBe("1.0m")
  })

  it("promotes to m before rounding can render an impossible '1000.0k'", () => {
    // (value / 1_000).toFixed(1) rounds half-up, so a value just under 1m must
    // promote to "m" or it prints "1000.0k". 999_950 is the smallest value that
    // rounds up to 1000.0k; 999_949 still rounds down and stays in "k".
    expect(formatTokens(999_949)).toBe("999.9k")
    expect(formatTokens(999_950)).toBe("1.0m")
    expect(formatTokens(999_999)).toBe("1.0m")
  })
})
