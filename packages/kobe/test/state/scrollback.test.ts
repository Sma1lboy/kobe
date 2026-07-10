/**
 * Scrollback preference normalization (state/scrollback.ts) — the PTY layer
 * feeds whatever state.json holds straight into xterm's `scrollback` option,
 * so garbage MUST coerce to the default and out-of-range values MUST clamp;
 * a NaN or negative reaching xterm-headless is undefined behavior.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_SCROLLBACK_ROWS,
  SCROLLBACK_ROWS_MAX,
  SCROLLBACK_ROWS_MIN,
  normalizeScrollbackRows,
} from "../../src/state/scrollback"

describe("normalizeScrollbackRows", () => {
  it("defaults to 1000", () => {
    expect(DEFAULT_SCROLLBACK_ROWS).toBe(1000)
    expect(normalizeScrollbackRows(undefined)).toBe(DEFAULT_SCROLLBACK_ROWS)
    expect(normalizeScrollbackRows(null)).toBe(DEFAULT_SCROLLBACK_ROWS)
    expect(normalizeScrollbackRows("garbage")).toBe(DEFAULT_SCROLLBACK_ROWS)
    expect(normalizeScrollbackRows(Number.NaN)).toBe(DEFAULT_SCROLLBACK_ROWS)
  })

  it("passes sane values through, flooring fractions and parsing strings", () => {
    expect(normalizeScrollbackRows(5000)).toBe(5000)
    expect(normalizeScrollbackRows(1234.9)).toBe(1234)
    expect(normalizeScrollbackRows(" 2000 ")).toBe(2000)
  })

  it("clamps out-of-range values", () => {
    expect(normalizeScrollbackRows(0)).toBe(SCROLLBACK_ROWS_MIN)
    expect(normalizeScrollbackRows(-50)).toBe(SCROLLBACK_ROWS_MIN)
    expect(normalizeScrollbackRows(10_000_000)).toBe(SCROLLBACK_ROWS_MAX)
  })
})
