import { CLAUDE_MODELS, claudeContextWindowFor } from "@/engine/claude-code-local/models"
import { describe, expect, it } from "vitest"

/**
 * The Claude model catalog is engine-owned UI data (CLAUDE.md): the composer's
 * model picker + footer read `label` verbatim and the context meter reads
 * `claudeContextWindowFor`. Pin the two contracts that matter — the
 * context-window math, and the picker-label style — without hardcoding the
 * mutable model list (ids rotate as Anthropic ships new builds).
 */

const LONG_CTX = 1_000_000
const STD_CTX = 200_000

describe("claudeContextWindowFor", () => {
  it("resolves the [1m] long-context build to a 1M window", () => {
    expect(claudeContextWindowFor("claude-opus-4-7[1m]")).toBe(LONG_CTX)
    expect(claudeContextWindowFor("claude-sonnet-4-6[1m]")).toBe(LONG_CTX)
  })

  it("resolves standard builds to the 200k window", () => {
    expect(claudeContextWindowFor("claude-opus-4-7")).toBe(STD_CTX)
    expect(claudeContextWindowFor("claude-sonnet-4-6")).toBe(STD_CTX)
    expect(claudeContextWindowFor("claude-haiku-4-5-20251001")).toBe(STD_CTX)
  })

  it("matches the 1m marker loosely (case-insensitive, variant spellings)", () => {
    expect(claudeContextWindowFor("claude-opus-4-7[1M]")).toBe(LONG_CTX)
    expect(claudeContextWindowFor("some-pinned-model-1m")).toBe(LONG_CTX)
  })

  it("falls back to the standard window for unknown / ad-hoc pinned ids", () => {
    expect(claudeContextWindowFor("")).toBe(STD_CTX)
    expect(claudeContextWindowFor("claude-3-5-haiku-20241022")).toBe(STD_CTX)
  })
})

describe("CLAUDE_MODELS catalog", () => {
  it("is non-empty and every entry is a well-formed claude model choice", () => {
    expect(CLAUDE_MODELS.length).toBeGreaterThan(0)
    for (const model of CLAUDE_MODELS) {
      expect(model.vendor).toBe("claude")
      expect(model.id.length).toBeGreaterThan(0)
      expect(model.label.length).toBeGreaterThan(0)
    }
  })

  it("labels use title-case product names, never a lowercase Opus/Sonnet/Haiku", () => {
    // Picker labels follow the house style (Opus 4.7, Codex, Claude Code): the
    // Anthropic product name is always capitalized. Guards the regression where
    // Sonnet/Haiku shipped lowercase while Opus was capitalized.
    for (const model of CLAUDE_MODELS) {
      expect(model.label).not.toMatch(/\b(opus|sonnet|haiku)\b/)
      expect(model.label).toMatch(/\b(Opus|Sonnet|Haiku)\b/)
    }
  })

  it("keys the long-context builds by the [1m] marker the context math reads", () => {
    for (const model of CLAUDE_MODELS) {
      const expected = /1m/i.test(model.id) ? LONG_CTX : STD_CTX
      expect(claudeContextWindowFor(model.id)).toBe(expected)
    }
  })

  it("offers the full effort ladder for each Opus family entry", () => {
    const LEVELS = ["low", "medium", "high", "xhigh", "max"]
    const opusIds = new Set(CLAUDE_MODELS.filter((m) => m.effort).map((m) => m.id))
    expect(opusIds.size).toBeGreaterThan(0)
    for (const id of opusIds) {
      const efforts = CLAUDE_MODELS.filter((m) => m.id === id && m.effort).map((m) => m.effort)
      expect(efforts).toEqual(LEVELS)
    }
  })
})
