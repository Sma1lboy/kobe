/**
 * Unit tests for the small pure composer glue modules — placeholder copy,
 * permission-mode label lookup, slash-description truncation, the key
 * predicates, the static keybinding table, and the model-picker row grouping.
 *
 * All of these are pure functions or plain data (no opentui runtime — the
 * `@opentui/core` import in keybindings.ts is type-only and erased), so they
 * run directly under vitest's node environment.
 */

import type { EngineCapabilities, ModelChoice } from "@/types/engine"
import type { TextareaRenderable } from "@opentui/core"
import { describe, expect, test, vi } from "vitest"
import { BUILTIN_CLAUDE_SLASHES } from "../../src/tui/chat/composer/builtin-slashes"
import { isCursorAtFirstLine, isCursorAtLastLine } from "../../src/tui/chat/composer/cursor"
import { PromptHistoryNavigator } from "../../src/tui/chat/composer/history-nav"
import { createImageAttach } from "../../src/tui/chat/composer/image-attach"
import { deleteImageTokenBackward, deleteImageTokenForward } from "../../src/tui/chat/composer/image-token-delete"
import { composerKeyBindings } from "../../src/tui/chat/composer/keybindings"
import { isPermissionModeCycleKey, isPlainAutocompleteTabKey } from "../../src/tui/chat/composer/keys"
import { modelPickerEffortOptions, modelPickerModelOptions } from "../../src/tui/chat/composer/model-picker-row"
import { permissionModeLabel } from "../../src/tui/chat/composer/permission-mode"
import { resolvePlaceholder } from "../../src/tui/chat/composer/placeholder"
import { formatSlashDescription } from "../../src/tui/chat/composer/slash-description"

/** Minimal EditBuffer-ish stand-in — records selection/delete/insert ops. */
function fakeTextarea(text = "", cursor = text.length) {
  return {
    plainText: text,
    cursorOffset: cursor,
    selection: null as null | [number, number],
    calls: [] as string[],
    hasSelection() {
      return this.selection !== null
    },
    setSelection(a: number, b: number) {
      this.selection = [a, b]
      this.calls.push(`setSelection(${a},${b})`)
    },
    deleteSelection() {
      if (this.selection) {
        const [a, b] = this.selection
        this.plainText = this.plainText.slice(0, a) + this.plainText.slice(b)
        this.cursorOffset = a
        this.selection = null
      }
      this.calls.push("deleteSelection")
    },
    insertText(t: string) {
      this.plainText = this.plainText.slice(0, this.cursorOffset) + t + this.plainText.slice(this.cursorOffset)
      this.cursorOffset += t.length
      this.calls.push(`insertText(${t})`)
    },
  }
}
type Fake = ReturnType<typeof fakeTextarea>
const asRef = (f: Fake) => f as unknown as TextareaRenderable

describe("resolvePlaceholder", () => {
  // The i18n runtime is injected (framework-free module, issue #15 G3);
  // a key-echo stub proves WHICH catalog key each fallback resolves.
  const translate = (key: string) => `<${key}>`

  test("no task → the noTask override or the i18n default", () => {
    expect(resolvePlaceholder({ isStreaming: false, hasTask: false, noTaskMessage: "nada" }, translate)).toBe("nada")
    expect(resolvePlaceholder({ isStreaming: true, hasTask: false, noTaskMessage: "nada" }, translate)).toBe("nada")
    // No override → falls through to translate("chat.composer.noTask").
    expect(resolvePlaceholder({ isStreaming: false, hasTask: false }, translate)).toBe("<chat.composer.noTask>")
  })

  test("streaming with a task → empty (placeholder hidden mid-stream)", () => {
    expect(resolvePlaceholder({ isStreaming: true, hasTask: true, inputPlaceholder: "Ask X" }, translate)).toBe("")
  })

  test("idle with a task → the input override or the i18n fallback", () => {
    expect(resolvePlaceholder({ isStreaming: false, hasTask: true, inputPlaceholder: "Ask X" }, translate)).toBe(
      "Ask X",
    )
    expect(resolvePlaceholder({ isStreaming: false, hasTask: true }, translate)).toBe("<chat.composer.askFallback>")
  })
})

describe("permissionModeLabel", () => {
  const caps: Pick<EngineCapabilities, "permissionModes"> = {
    permissionModes: [
      { id: "default", label: "Ask each time" },
      { id: "acceptEdits", label: "Auto-accept edits" },
    ],
  }

  test("resolves a known mode to its label", () => {
    expect(permissionModeLabel(caps, "acceptEdits")).toBe("Auto-accept edits")
  })

  test("undefined mode falls back to the `default` entry", () => {
    expect(permissionModeLabel(caps, undefined)).toBe("Ask each time")
  })

  test("unknown mode with no matching entry echoes the id", () => {
    expect(permissionModeLabel({ permissionModes: [] }, "plan")).toBe("plan")
  })
})

describe("formatSlashDescription", () => {
  test("undefined / empty / whitespace-only → undefined", () => {
    expect(formatSlashDescription(undefined)).toBeUndefined()
    expect(formatSlashDescription("")).toBeUndefined()
    expect(formatSlashDescription("   \n\t  ")).toBeUndefined()
  })

  test("collapses interior whitespace to single spaces", () => {
    expect(formatSlashDescription("compact   the\n\tconversation")).toBe("compact the conversation")
  })

  test("truncates with an ellipsis past the 72-char cap", () => {
    const long = "x".repeat(100)
    const out = formatSlashDescription(long)
    expect(out).toHaveLength(72)
    expect(out?.endsWith("...")).toBe(true)
  })

  test("keeps a description exactly at the cap intact", () => {
    const exact = "y".repeat(72)
    expect(formatSlashDescription(exact)).toBe(exact)
  })
})

describe("composer key predicates", () => {
  test("shift+tab and backtab are the permission-mode cycle key", () => {
    expect(isPermissionModeCycleKey({ name: "tab", shift: true })).toBe(true)
    expect(isPermissionModeCycleKey({ name: "backtab" })).toBe(true)
    expect(isPermissionModeCycleKey({ name: "tab" })).toBe(false)
    expect(isPermissionModeCycleKey({ name: "return", shift: true })).toBe(false)
  })

  test("plain tab (no modifiers) is the autocomplete key; a `\\t` sequence counts too", () => {
    expect(isPlainAutocompleteTabKey({ name: "tab" })).toBe(true)
    expect(isPlainAutocompleteTabKey({ sequence: "\t" })).toBe(true)
    expect(isPlainAutocompleteTabKey({ name: "tab", shift: true })).toBe(false)
    expect(isPlainAutocompleteTabKey({ name: "tab", ctrl: true })).toBe(false)
    expect(isPlainAutocompleteTabKey({ name: "tab", meta: true })).toBe(false)
    expect(isPlainAutocompleteTabKey({ name: "tab", super: true })).toBe(false)
  })
})

describe("composerKeyBindings", () => {
  test("flips enter→submit, shift+enter→newline, linefeed→newline", () => {
    expect(composerKeyBindings).toContainEqual({ name: "return", action: "submit" })
    expect(composerKeyBindings).toContainEqual({ name: "return", shift: true, action: "newline" })
    expect(composerKeyBindings).toContainEqual({ name: "linefeed", action: "newline" })
  })
})

describe("modelPickerModelOptions", () => {
  const choices: ModelChoice[] = [
    { vendor: "claude", id: "opus", label: "Opus", hint: "big" },
    { vendor: "claude", id: "opus", effort: "high", label: "Opus · high" },
    { vendor: "codex", id: "gpt", label: "GPT" },
  ]

  test("groups vendor:id, dedups, and keeps every effort choice in the bucket", () => {
    const opts = modelPickerModelOptions(choices)
    expect(opts).toHaveLength(2)
    const opus = opts.find((o) => o.id === "opus")
    expect(opus?.label).toBe("Opus")
    expect(opus?.choices).toHaveLength(2)
    expect(opus?.disabled).toBe(false)
  })

  test("strips the ` · <effort>` suffix when the base choice carries an effort", () => {
    // Bucket whose only member is an effort-bound choice → label suffix stripped.
    const opts = modelPickerModelOptions([
      { vendor: "claude", id: "sonnet", effort: "medium", label: "Sonnet · medium" },
    ])
    expect(opts[0]?.label).toBe("Sonnet")
  })

  test("lockedVendor disables options from other vendors", () => {
    const opts = modelPickerModelOptions(choices, { lockedVendor: "claude" })
    const codex = opts.find((o) => o.vendor === "codex")
    expect(codex?.disabled).toBe(true)
    expect(codex?.disabledReason).toBe("new chat required")
    expect(opts.find((o) => o.vendor === "claude")?.disabled).toBe(false)
  })
})

describe("modelPickerEffortOptions", () => {
  test("maps each choice, labelling the effort-less choice `default`", () => {
    const [model] = modelPickerModelOptions([
      { vendor: "claude", id: "opus", label: "Opus", hint: "base hint" },
      { vendor: "claude", id: "opus", effort: "high", label: "Opus · high", hint: "fast hint" },
    ])
    const efforts = modelPickerEffortOptions(model!)
    expect(efforts.map((e) => e.label)).toEqual(["default", "high"])
    // Effort-less choice inherits its own hint; here it has one.
    expect(efforts[0]?.hint).toBe("base hint")
    expect(efforts[1]?.effort).toBe("high")
  })

  test("effort-less choice with no hint gets the `use the model default` hint", () => {
    const [model] = modelPickerModelOptions([{ vendor: "claude", id: "haiku", label: "Haiku" }])
    const efforts = modelPickerEffortOptions(model!)
    expect(efforts[0]?.hint).toBe("use the model default")
  })
})

describe("builtin-slashes re-export", () => {
  test("surfaces the generated Claude slash catalog", () => {
    expect(Array.isArray(BUILTIN_CLAUDE_SLASHES)).toBe(true)
    expect(BUILTIN_CLAUDE_SLASHES.length).toBeGreaterThan(0)
    expect(BUILTIN_CLAUDE_SLASHES.some((s) => s.name === "compact")).toBe(true)
  })
})

describe("cursor line predicates", () => {
  test("undefined ref → treated as both first and last line", () => {
    expect(isCursorAtFirstLine(undefined)).toBe(true)
    expect(isCursorAtLastLine(undefined)).toBe(true)
  })

  test("first line: true only while no newline precedes the caret", () => {
    expect(isCursorAtFirstLine(asRef(fakeTextarea("one\ntwo", 2)))).toBe(true)
    expect(isCursorAtFirstLine(asRef(fakeTextarea("one\ntwo", 5)))).toBe(false)
  })

  test("last line: true only while no newline follows the caret", () => {
    expect(isCursorAtLastLine(asRef(fakeTextarea("one\ntwo", 5)))).toBe(true)
    expect(isCursorAtLastLine(asRef(fakeTextarea("one\ntwo", 2)))).toBe(false)
  })
})

describe("deleteImageToken", () => {
  test("backward: deletes a whole `[Image #N]` token sitting before the caret", () => {
    const ta = fakeTextarea("hi [Image #2]")
    expect(deleteImageTokenBackward(asRef(ta))).toBe(true)
    expect(ta.plainText).toBe("hi ")
  })

  test("backward: no-op when the caret isn't right after a token", () => {
    expect(deleteImageTokenBackward(asRef(fakeTextarea("plain text")))).toBe(false)
    expect(deleteImageTokenBackward(asRef(fakeTextarea("", 0)))).toBe(false)
    expect(deleteImageTokenBackward(undefined)).toBe(false)
  })

  test("backward: no-op while a selection is active", () => {
    const ta = fakeTextarea("x [Image #1]")
    ta.selection = [0, 1]
    expect(deleteImageTokenBackward(asRef(ta))).toBe(false)
  })

  test("forward: deletes a token starting at the caret", () => {
    const ta = fakeTextarea("[Image #7] tail", 0)
    expect(deleteImageTokenForward(asRef(ta))).toBe(true)
    expect(ta.plainText).toBe(" tail")
  })

  test("forward: no-op at end of buffer or when no token starts at the caret", () => {
    expect(deleteImageTokenForward(asRef(fakeTextarea("abc", 3)))).toBe(false)
    expect(deleteImageTokenForward(asRef(fakeTextarea("abc[Image #1]", 0)))).toBe(false)
    expect(deleteImageTokenForward(undefined)).toBe(false)
  })
})

describe("PromptHistoryNavigator", () => {
  function nav(entries: string[]) {
    let buffer = ""
    const list = [...entries]
    const n = new PromptHistoryNavigator(
      () => list,
      () => buffer,
      (t) => {
        buffer = t
      },
    )
    return {
      n,
      get: () => buffer,
      set: (v: string) => {
        buffer = v
      },
    }
  }

  test("prev walks newest→oldest then clamps at the top", () => {
    const h = nav(["a", "b", "c"])
    h.set("draft")
    expect(h.n.prev()).toBe(true)
    expect(h.get()).toBe("c")
    h.n.prev()
    expect(h.get()).toBe("b")
    h.n.prev()
    expect(h.get()).toBe("a")
    expect(h.n.prev()).toBe(true) // clamped, still handled
    expect(h.get()).toBe("a")
    expect(h.n.isActive()).toBe(true)
  })

  test("next walks back down and restores the live draft at the bottom", () => {
    const h = nav(["a", "b"])
    h.set("draft")
    h.n.prev() // → b
    h.n.prev() // → a
    h.n.next() // → b
    expect(h.get()).toBe("b")
    h.n.next() // → restore draft
    expect(h.get()).toBe("draft")
    expect(h.n.isActive()).toBe(false)
  })

  test("prev on empty history and next while inactive are no-ops", () => {
    const empty = nav([])
    expect(empty.n.prev()).toBe(false)
    const h = nav(["a"])
    expect(h.n.next()).toBe(false) // not active yet
  })

  test("reset drops navigation state", () => {
    const h = nav(["a"])
    h.n.prev()
    h.n.reset()
    expect(h.n.isActive()).toBe(false)
  })
})

describe("createImageAttach", () => {
  function build() {
    const ta = fakeTextarea("start ")
    const saveBytes = vi.fn(() => ({ token: "[Image #1]", entry: {} }))
    const saveFromClipboard = vi.fn(async () => ({ token: "[Image #2]", entry: {} }))
    const setPasteHint = vi.fn()
    const attach = createImageAttach({
      getTextarea: () => asRef(ta),
      imageRegistry: { saveBytes, saveFromClipboard } as never,
      setPasteHint,
    })
    return { ta, saveBytes, saveFromClipboard, setPasteHint, attach }
  }

  test("insertAtCursor writes through the textarea", () => {
    const { ta, attach } = build()
    attach.insertAtCursor("X")
    expect(ta.plainText).toBe("start X")
  })

  test("handlePaste ignores non-image pastes", () => {
    const { saveBytes, attach } = build()
    attach.handlePaste({
      metadata: { mimeType: "text/plain" },
      bytes: new Uint8Array(),
      preventDefault: vi.fn(),
    } as never)
    expect(saveBytes).not.toHaveBeenCalled()
  })

  test("handlePaste saves image bytes and inserts a spaced token", () => {
    const { ta, saveBytes, attach } = build()
    const preventDefault = vi.fn()
    attach.handlePaste({ metadata: { mimeType: "image/png" }, bytes: new Uint8Array([1]), preventDefault } as never)
    expect(saveBytes).toHaveBeenCalled()
    expect(ta.plainText).toBe("start  [Image #1] ")
    expect(preventDefault).toHaveBeenCalled()
  })

  test("handlePaste surfaces a hint when the disk write throws", () => {
    const { attach, saveBytes, setPasteHint } = build()
    saveBytes.mockImplementationOnce(() => {
      throw new Error("disk full")
    })
    attach.handlePaste({
      metadata: { mimeType: "image/png" },
      bytes: new Uint8Array([1]),
      preventDefault: vi.fn(),
    } as never)
    expect(setPasteHint).toHaveBeenCalledWith(expect.stringContaining("disk full"))
  })

  test("tryAttachClipboardImage inserts the token on a hit", async () => {
    const { ta, attach, setPasteHint } = build()
    await attach.tryAttachClipboardImage()
    // Only exercises the real clipboard on darwin; on other platforms the
    // support check short-circuits with a hint and no insertion.
    if (process.platform === "darwin") {
      expect(ta.plainText).toBe("start  [Image #2] ")
      expect(setPasteHint).toHaveBeenCalledWith(null)
    } else {
      expect(setPasteHint).toHaveBeenCalledWith(expect.stringContaining("not yet supported"))
    }
  })

  test("tryAttachClipboardImage hints when the clipboard has no image", async () => {
    if (process.platform !== "darwin") return
    const { attach, saveFromClipboard, setPasteHint } = build()
    saveFromClipboard.mockResolvedValueOnce(null as never)
    await attach.tryAttachClipboardImage()
    expect(setPasteHint).toHaveBeenCalledWith("no image on clipboard")
  })
})
