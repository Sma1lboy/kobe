import { describe, expect, it } from "vitest"
import {
  buildEditorCommand,
  buildNvimDiffCommand,
  editorWindowLabel,
  relativeToWorktree,
} from "../../src/tmux/editor-launch.ts"
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

describe("relativeToWorktree", () => {
  it("strips the worktree prefix (with or without a trailing slash)", () => {
    expect(relativeToWorktree("/wt", "/wt/src/a.ts")).toBe("src/a.ts")
    expect(relativeToWorktree("/wt/", "/wt/src/a.ts")).toBe("src/a.ts")
  })

  it("returns null when the path isn't under the worktree (skips diff upgrade)", () => {
    expect(relativeToWorktree("/wt", "/other/a.ts")).toBeNull()
    expect(relativeToWorktree("/wt", "/wt-2/a.ts")).toBeNull()
  })
})

describe("buildNvimDiffCommand", () => {
  it("dumps HEAD to a tmp file and diffs it read-only against the live file", () => {
    const cmd = buildNvimDiffCommand("nvim", "/wt/src/a.ts", "src/a.ts")
    expect(cmd).toContain("f=$(mktemp 2>/dev/null)")
    expect(cmd).toContain("git show 'HEAD:./src/a.ts' > \"$f\"")
    expect(cmd).toContain("nvim -d \"$f\" '/wt/src/a.ts' -c 'setlocal nomodifiable' -c 'wincmd l'")
    expect(cmd).toContain('rm -f "$f" 2>/dev/null; exit $r')
  })

  it("falls back to a plain open when the HEAD blob can't be read", () => {
    const cmd = buildNvimDiffCommand("nvim", "/wt/a.ts", "a.ts")
    expect(cmd).toContain("else\n  nvim '/wt/a.ts'; r=$?")
  })

  it("honours vim as the diff binary too", () => {
    const cmd = buildNvimDiffCommand("vim", "/wt/a.ts", "a.ts")
    expect(cmd).toContain("vim -d \"$f\" '/wt/a.ts'")
  })

  it("shell-escapes paths with spaces and quotes on both sh layers", () => {
    const cmd = buildNvimDiffCommand("nvim", "/wt/a b/it's.ts", "a b/it's.ts")
    expect(cmd).toContain("git show 'HEAD:./a b/it'\\''s.ts'")
    expect(cmd).toContain("nvim -d \"$f\" '/wt/a b/it'\\''s.ts'")
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
