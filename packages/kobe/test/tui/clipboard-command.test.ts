/**
 * Pure-helper tests for system-clipboard command resolution.
 */

import { describe, expect, test } from "vitest"
import { resolveClipboardCopyCommand } from "../../src/lib/clipboard-command"

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
