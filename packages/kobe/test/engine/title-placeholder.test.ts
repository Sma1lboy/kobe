/**
 * `engineDisplayTitle` / `isEnginePlaceholderTitle` — some engines write an
 * internal IDENTIFIER into their OSC title when they have no name to show.
 * Codex is the case that forced this: with Rove's
 * `tui.terminal_title=["activity","thread-title"]` override, its
 * `thread-title` segment resolves to the thread's user-assigned NAME and
 * falls back to the thread UUID — and no Rove-launched session has a name,
 * so every codex tab read `01a00ea6-79cb-7413-bf83-b897ac2da2ff 1` (owner
 * report 2026-08-17; reproduced against codex-cli 0.147 on a fresh session
 * AND on a resumed one that already had a stored title).
 *
 * The vocabulary is engine-declared (`terminalTitle.placeholderTitles`), so
 * no neutral layer learns a vendor's id shape.
 */

import { describe, expect, it } from "vitest"
import { engineDisplayTitle, isEnginePlaceholderTitle } from "../../src/engine/registry"
import { isPlaceholderTitle } from "../../src/engine/title-policy"

/** A real codex thread id (UUIDv7) as it arrives on the OSC stream. */
const THREAD_ID = "01a00ea6-79cb-7413-bf83-b897ac2da2ff"

describe("engineDisplayTitle — identifier placeholders", () => {
  it("collapses codex's bare thread id to no-title", () => {
    expect(engineDisplayTitle(THREAD_ID, "codex")).toBe("")
    expect(isEnginePlaceholderTitle(THREAD_ID, "codex")).toBe(true)
  })

  it("collapses it with codex's spinner frame in front (a running turn)", () => {
    // The spinner is stripped first, so the placeholder check sees the id.
    expect(engineDisplayTitle(`⠴ ${THREAD_ID}`, "codex")).toBe("")
    expect(engineDisplayTitle(`⠋ ${THREAD_ID}`, "codex")).toBe("")
  })

  it("leaves a real name alone", () => {
    expect(engineDisplayTitle("⠹ add the ruler", "codex")).toBe("add the ruler")
    expect(engineDisplayTitle("✳ 运行本地Codex处理图片", "claude")).toBe("运行本地Codex处理图片")
    // A name that merely CONTAINS an id is a name — patterns are anchored.
    expect(engineDisplayTitle(`resume ${THREAD_ID}`, "codex")).toBe(`resume ${THREAD_ID}`)
  })

  // Same rule as the status strip: `vendor` narrows the vocabulary, it never
  // gates the check. The live-engine probe is a ~2s ps walk, so most ticks
  // have no vendor — and that title is what gets RECORDED as `lastTitle`.
  it("catches the id without a resolved vendor (union vocabulary)", () => {
    expect(engineDisplayTitle(THREAD_ID, null)).toBe("")
    expect(engineDisplayTitle(THREAD_ID, undefined)).toBe("")
    // A vendor that declares no patterns of its own also falls back to the
    // union — no engine writes a bare UUID it wants kept.
    expect(engineDisplayTitle(THREAD_ID, "copilot")).toBe("")
    expect(engineDisplayTitle(THREAD_ID, "my-custom-engine")).toBe("")
  })

  it("an empty title is absent, not a placeholder", () => {
    expect(isEnginePlaceholderTitle("", "codex")).toBe(false)
    expect(isEnginePlaceholderTitle("   ", "codex")).toBe(false)
    expect(engineDisplayTitle("", "codex")).toBe("")
  })
})

describe("isPlaceholderTitle (pure matcher)", () => {
  it("matches on the trimmed title and never mutates regex state", () => {
    const patterns = [/^\d+$/]
    // A `g` regex would alternate true/false across calls — the contract
    // forbids one, and a non-global pattern is stable.
    expect(isPlaceholderTitle(" 123 ", patterns)).toBe(true)
    expect(isPlaceholderTitle("123", patterns)).toBe(true)
    expect(isPlaceholderTitle("123 files", patterns)).toBe(false)
  })

  it("an engine that declares nothing never rejects a title", () => {
    expect(isPlaceholderTitle(THREAD_ID, [])).toBe(false)
  })
})
