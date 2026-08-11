/**
 * `stripEngineStatusPrefix` — an engine that owns its OSC title writes its
 * turn state into it, and kobe draws that same state in its own glyph
 * column. Rendering both says the fact twice, and the ANIMATED variants make
 * a resting tab look busy (owner 2026-08-10). The glyph vocabulary is
 * declared per engine, so no neutral layer hard-codes a vendor's characters.
 */

import { describe, expect, it } from "vitest"
import { stripEngineStatusPrefix } from "../../src/engine/registry"

describe("stripEngineStatusPrefix", () => {
  it("strips claude's resting and animated prefixes", () => {
    // `${prefix} ${title}` — ✳ at rest, ⠂/⠐ alternating during a turn.
    expect(stripEngineStatusPrefix("✳ 运行本地Codex处理图片", "claude")).toBe("运行本地Codex处理图片")
    expect(stripEngineStatusPrefix("⠂ fixing the watcher", "claude")).toBe("fixing the watcher")
    expect(stripEngineStatusPrefix("⠐ fixing the watcher", "claude")).toBe("fixing the watcher")
  })

  it("strips codex's spinner frame", () => {
    expect(stripEngineStatusPrefix("⠹ add the ruler", "codex")).toBe("add the ruler")
    expect(stripEngineStatusPrefix("⠏ add the ruler", "codex")).toBe("add the ruler")
  })

  it("leaves an already-clean title alone", () => {
    expect(stripEngineStatusPrefix("Claude Code", "claude")).toBe("Claude Code")
    expect(stripEngineStatusPrefix("add the ruler", "codex")).toBe("add the ruler")
  })

  it("does not strip one engine's glyphs from another's title", () => {
    // ✳ is claude's; codex never writes it, so a codex thread NAMED that
    // keeps its name.
    expect(stripEngineStatusPrefix("✳ literal", "codex")).toBe("✳ literal")
  })

  it("leaves the title alone when there is no vendor at all", () => {
    expect(stripEngineStatusPrefix("✳ 运行本地Codex处理图片", null)).toBe("✳ 运行本地Codex处理图片")
    expect(stripEngineStatusPrefix("✳ whatever", undefined)).toBe("✳ whatever")
  })

  // A vendor that declares NO vocabulary falls back to the union of every
  // built-in's glyphs. That case is the norm, not an edge: a user wrapper
  // (`claudecpa` — a zsh function that ends up running real claude)
  // registers as a CUSTOM engine and carries no `terminalTitle`, so a
  // per-vendor-only lookup left exactly those tabs wearing `⠂ …`.
  it("falls back to every built-in's glyphs for a vendor that declares none", () => {
    expect(stripEngineStatusPrefix("⠂ Herdr多Agent协作技巧分享", "claudecpa" as never)).toBe("Herdr多Agent协作技巧分享")
    expect(stripEngineStatusPrefix("✳ whatever", "copilot")).toBe("whatever")
    // Still conservative: decoration-only stays a name.
    expect(stripEngineStatusPrefix("⠂", "claudecpa" as never)).toBe("⠂")
  })

  // A prefix that would eat the entire title is a NAME, not a status: the
  // alternative renames such a session to the vendor default.
  it("never consumes the whole title", () => {
    expect(stripEngineStatusPrefix("✳", "claude")).toBe("✳")
    expect(stripEngineStatusPrefix("✳   ", "claude")).toBe("✳   ")
  })

  it("only strips at the START — a glyph inside the name survives", () => {
    expect(stripEngineStatusPrefix("build ✳ step", "claude")).toBe("build ✳ step")
  })
})
