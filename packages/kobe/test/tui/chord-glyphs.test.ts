import { describe, expect, it } from "vitest"
import { formatChord, tmuxPrefixGlyph } from "../../src/tui/lib/chord-glyphs.ts"

describe("formatChord", () => {
  it("renders modifier chords as glyph cluster + space + uppercased key", () => {
    expect(formatChord("ctrl+q")).toBe("⌃ Q")
    expect(formatChord("cmd+p")).toBe("⌘ P")
    expect(formatChord("ctrl+shift+t")).toBe("⌃⇧ T")
    expect(formatChord("ctrl+[")).toBe("⌃ [")
    expect(formatChord("ctrl+,")).toBe("⌃ ,")
    expect(formatChord("ctrl+hjkl")).toBe("⌃ HJKL")
  })

  it("maps named keys to glyphs, but leaves tab as the word", () => {
    expect(formatChord("enter")).toBe("⏎")
    expect(formatChord("esc")).toBe("⎋")
    expect(formatChord("space")).toBe("␣")
    expect(formatChord("ctrl+enter")).toBe("⌃ ⏎")
    expect(formatChord("ctrl+pgup")).toBe("⌃ ⇞")
    expect(formatChord("tab")).toBe("tab")
    expect(formatChord("shift+tab")).toBe("⇧ tab")
  })

  it("keeps function keys, and keeps BARE keys in their typed case (#14)", () => {
    expect(formatChord("F1")).toBe("F1")
    expect(formatChord("f2")).toBe("F2")
    expect(formatChord("n")).toBe("n") // bare plain-letter — the literal key to press
    expect(formatChord("M")).toBe("M") // bare capital (Shift+M) stays capital
  })

  it("renders a tmux prefix chord as two steps", () => {
    expect(formatChord("prefix f")).toBe("⌃B F")
    expect(formatChord("prefix t", "⌃A")).toBe("⌃A T")
  })

  it("handles `/` compound keys, casing each side by context", () => {
    expect(formatChord("j/k")).toBe("j/k") // bare → keep case
    expect(formatChord("h/l")).toBe("h/l")
    expect(formatChord("enter/esc")).toBe("⏎/⎋")
    expect(formatChord("[/]")).toBe("[/]")
    expect(formatChord("ctrl+[/]")).toBe("⌃ [/]") // modified
    expect(formatChord("1-9")).toBe("1-9")
  })
})

describe("tmuxPrefixGlyph", () => {
  it("parses `prefix C-b` / bare `C-a` / `M-x`", () => {
    expect(tmuxPrefixGlyph("prefix C-b")).toBe("⌃B")
    expect(tmuxPrefixGlyph("C-a")).toBe("⌃A")
    expect(tmuxPrefixGlyph("M-x")).toBe("⌥X")
  })

  it("returns null for anything unparseable", () => {
    expect(tmuxPrefixGlyph("garbage")).toBeNull()
    expect(tmuxPrefixGlyph("")).toBeNull()
  })
})
