/**
 * Pure-helper tests for system-clipboard copy resolution + the tmux config
 * fragment that wires a pane-aware drag selection to the OS clipboard.
 *
 * The real tmux mouse/copy-mode behaviour needs a live terminal and is
 * verified manually; here we pin the platform→command resolution and the
 * generated config sequence (set-clipboard + copy-pipe bindings).
 */

import { describe, expect, test } from "vitest"
import { clipboardTmuxConfig, resolveClipboardCopyCommand } from "../../src/tmux/clipboard"

const none = () => false
const all = () => true

describe("resolveClipboardCopyCommand", () => {
  test("darwin → pbcopy (probe irrelevant)", () => {
    expect(resolveClipboardCopyCommand("darwin", none)).toBe("pbcopy")
    expect(resolveClipboardCopyCommand("darwin", all)).toBe("pbcopy")
  })

  test("linux with wl-copy available → wl-copy (Wayland preferred)", () => {
    expect(resolveClipboardCopyCommand("linux", all)).toBe("wl-copy")
  })

  test("linux with only xclip → xclip clipboard command", () => {
    const onlyXclip = (bin: string) => bin === "xclip"
    expect(resolveClipboardCopyCommand("linux", onlyXclip)).toBe("xclip -selection clipboard -in")
  })

  test("linux with only xsel → xsel clipboard command", () => {
    const onlyXsel = (bin: string) => bin === "xsel"
    expect(resolveClipboardCopyCommand("linux", onlyXsel)).toBe("xsel --clipboard --input")
  })

  test("linux preference order: wl-copy beats xclip beats xsel", () => {
    const noWayland = (bin: string) => bin === "xclip" || bin === "xsel"
    expect(resolveClipboardCopyCommand("linux", noWayland)).toBe("xclip -selection clipboard -in")
  })

  test("linux with no clipboard tool → null", () => {
    expect(resolveClipboardCopyCommand("linux", none)).toBeNull()
  })

  test("unknown platform → null", () => {
    expect(resolveClipboardCopyCommand("win32", all)).toBeNull()
    expect(resolveClipboardCopyCommand("freebsd", all)).toBeNull()
  })
})

describe("clipboardTmuxConfig", () => {
  test("always sets set-clipboard on", () => {
    for (const cmd of [null, "pbcopy"]) {
      expect(clipboardTmuxConfig(cmd)).toContainEqual(["set-option", "-g", "set-clipboard", "on"])
    }
  })

  test("with a clip command: binds copy-pipe-and-cancel for drag + keyboard in both copy-mode tables", () => {
    const config = clipboardTmuxConfig("pbcopy")
    for (const table of ["copy-mode", "copy-mode-vi"]) {
      for (const trigger of ["MouseDragEnd1Pane", "y", "Enter"]) {
        expect(config).toContainEqual([
          "bind-key",
          "-T",
          table,
          trigger,
          "send-keys",
          "-X",
          "copy-pipe-and-cancel",
          "pbcopy",
        ])
      }
    }
    // 2 set-options + 2 tables * 3 triggers = 8 commands.
    expect(config).toHaveLength(8)
  })

  test("with a clip command: sets copy-command so a binding stripped to a bare copy-pipe (oh-my-tmux rewrite) still reaches the clipboard", () => {
    expect(clipboardTmuxConfig("pbcopy")).toContainEqual(["set-option", "-g", "copy-command", "pbcopy"])
  })

  test("MouseDragEnd1Pane (the drag-release flow) pipes to the resolved command", () => {
    const config = clipboardTmuxConfig("xclip -selection clipboard -in")
    const dragBinds = config.filter((c) => c.includes("MouseDragEnd1Pane"))
    expect(dragBinds).toHaveLength(2)
    for (const bind of dragBinds) {
      expect(bind).toContain("copy-pipe-and-cancel")
      expect(bind.at(-1)).toBe("xclip -selection clipboard -in")
    }
  })

  test("no clip command: keeps set-clipboard but omits every copy-pipe binding", () => {
    const config = clipboardTmuxConfig(null)
    expect(config).toEqual([["set-option", "-g", "set-clipboard", "on"]])
    expect(config.some((c) => c.includes("copy-pipe-and-cancel"))).toBe(false)
  })
})
