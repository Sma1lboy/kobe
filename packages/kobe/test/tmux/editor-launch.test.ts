import { describe, expect, it } from "vitest"
import { buildEditorCommand } from "../../src/tmux/editor-launch.ts"
import { DEFAULT_EDITOR_KIND, normalizeEditorKind } from "../../src/tui/lib/editor-prefs.ts"

describe("buildEditorCommand", () => {
  it("vim / nano open the shell-quoted path", () => {
    expect(buildEditorCommand("vim", "", "/wt/src/a.ts")).toEqual({ bin: "vim", command: "vim '/wt/src/a.ts'" })
    expect(buildEditorCommand("nano", "", "/wt/b.md")).toEqual({ bin: "nano", command: "nano '/wt/b.md'" })
  })

  it("vim / nano ignore any custom command", () => {
    expect(buildEditorCommand("vim", "code -w", "/wt/a.ts")?.command).toBe("vim '/wt/a.ts'")
  })

  it("custom appends the quoted path when there's no {file} placeholder", () => {
    expect(buildEditorCommand("custom", "code -w", "/wt/a.ts")).toEqual({
      bin: "code",
      command: "code -w '/wt/a.ts'",
    })
  })

  it("custom substitutes {file} in place (every occurrence)", () => {
    expect(buildEditorCommand("custom", "emacsclient {file}", "/wt/a.ts")?.command).toBe("emacsclient '/wt/a.ts'")
    expect(buildEditorCommand("custom", "diff {file} {file}", "/wt/a.ts")?.command).toBe("diff '/wt/a.ts' '/wt/a.ts'")
  })

  it("custom binary token is the first word (for the PATH pre-flight)", () => {
    expect(buildEditorCommand("custom", "subl -w -n", "/wt/a.ts")?.bin).toBe("subl")
  })

  it("empty custom falls back to $VISUAL/$EDITOR", () => {
    expect(buildEditorCommand("custom", "", "/wt/a.ts", "hx")).toEqual({ bin: "hx", command: "hx '/wt/a.ts'" })
    expect(buildEditorCommand("custom", "   ", "/wt/a.ts", "code -w {file}")?.command).toBe("code -w '/wt/a.ts'")
  })

  it("returns null when custom is empty and no env editor is set (caller → preview)", () => {
    expect(buildEditorCommand("custom", "", "/wt/a.ts")).toBeNull()
    expect(buildEditorCommand("custom", "", "/wt/a.ts", "")).toBeNull()
  })

  it("shell-escapes a path with spaces and quotes", () => {
    expect(buildEditorCommand("vim", "", "/wt/a b/it's.ts")?.command).toBe("vim '/wt/a b/it'\\''s.ts'")
  })
})

describe("normalizeEditorKind", () => {
  it("passes through valid kinds", () => {
    expect(normalizeEditorKind("vim")).toBe("vim")
    expect(normalizeEditorKind("nano")).toBe("nano")
    expect(normalizeEditorKind("custom")).toBe("custom")
  })

  it("defaults to vim for unset / unknown values", () => {
    expect(normalizeEditorKind(undefined)).toBe(DEFAULT_EDITOR_KIND)
    expect(normalizeEditorKind("emacs")).toBe("vim")
    expect(normalizeEditorKind(42)).toBe("vim")
  })
})
