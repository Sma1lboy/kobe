import { describe, expect, it } from "vitest"
import { buildEditorCommand, editorWindowLabel } from "../../src/tmux/editor-launch.ts"
import { DEFAULT_EDITOR_KIND, normalizeEditorKind } from "../../src/tui/lib/editor-prefs.ts"

describe("buildEditorCommand", () => {
  it("explicit terminal editors open the shell-quoted path", () => {
    expect(buildEditorCommand("vim", "", "/wt/src/a.ts")).toEqual({ bin: "vim", command: "vim '/wt/src/a.ts'" })
    expect(buildEditorCommand("nvim", "", "/wt/src/a.ts")).toEqual({ bin: "nvim", command: "nvim '/wt/src/a.ts'" })
    expect(buildEditorCommand("nano", "", "/wt/b.md")).toEqual({ bin: "nano", command: "nano '/wt/b.md'" })
    expect(buildEditorCommand("emacs", "", "/wt/b.md")).toEqual({ bin: "emacs", command: "emacs '/wt/b.md'" })
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

describe("editorWindowLabel", () => {
  it("labels the tmux window with the edited file's name (basename)", () => {
    expect(editorWindowLabel("/wt/src/index.ts")).toBe("index.ts")
    expect(editorWindowLabel("/wt/a b/it's.md")).toBe("it's.md")
    expect(editorWindowLabel("README")).toBe("README")
  })

  it("falls back to 'edit' for an empty path", () => {
    expect(editorWindowLabel("")).toBe("edit")
    expect(editorWindowLabel("  ")).toBe("edit")
  })
})

describe("normalizeEditorKind", () => {
  it("passes through valid kinds", () => {
    for (const k of ["auto", "vim", "nvim", "nano", "emacs", "custom"]) {
      expect(normalizeEditorKind(k)).toBe(k)
    }
  })

  it("defaults to auto for unset / unknown values", () => {
    expect(DEFAULT_EDITOR_KIND).toBe("auto")
    expect(normalizeEditorKind(undefined)).toBe("auto")
    expect(normalizeEditorKind("sublime")).toBe("auto")
    expect(normalizeEditorKind(42)).toBe("auto")
  })
})
