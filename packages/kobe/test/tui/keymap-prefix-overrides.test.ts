import { describe, expect, test } from "vitest"
import { applyPrefixKeymapOverrides, extractPrefixKeybindings } from "../../src/tui/lib/keymap-prefix-overrides"

const keymap = [
  { id: "chat.tab.new", scope: "workspace", keys: [], prefixKeys: ["t"] },
  { id: "task.new", scope: "sidebar", keys: ["n"] },
  { id: "focus.numeric", scope: "global", keys: [], prefixKeys: ["h", "j", "k", "l"] },
]

describe("PureTUI prefix settings", () => {
  test("reads a prefix key, timeout, and second-stroke overrides", () => {
    const extracted = extractPrefixKeybindings(
      {
        prefix: { key: "ctrl+b", timeoutMs: 750, bindings: { "chat.tab.new": "n" } },
      },
      "linux",
    )

    expect(extracted.configuration).toEqual({ key: "ctrl+b", timeoutMs: 750 })
    expect(extracted.entries).toEqual([{ id: "chat.tab.new", keys: ["n"] }])
    expect(extracted.warnings).toEqual([])
  })

  test("lets a platform prefix overlay replace only named fields", () => {
    const extracted = extractPrefixKeybindings(
      {
        prefix: { key: "ctrl+a", timeoutMs: 1000, bindings: { "chat.tab.new": "t" } },
        darwin: { prefix: { key: "ctrl+b", bindings: { "chat.tab.new": "n" } } },
      },
      "darwin",
    )

    expect(extracted.configuration).toEqual({ key: "ctrl+b", timeoutMs: 1000 })
    expect(extracted.entries).toEqual([{ id: "chat.tab.new", keys: ["n"] }])
  })

  test("rejects a bare prefix while retaining valid second strokes", () => {
    const extracted = extractPrefixKeybindings(
      {
        prefix: { key: "a", bindings: { "chat.tab.new": "n" } },
      },
      "linux",
    )

    expect(extracted.configuration).toEqual({})
    expect(extracted.entries).toEqual([{ id: "chat.tab.new", keys: ["n"] }])
    expect(extracted.warnings.join("\n")).toContain("modifier")
  })

  test("changes only declared prefix rows and preserves the direct key slots", () => {
    const copy = keymap.map((row) => ({
      ...row,
      keys: [...row.keys],
      prefixKeys: row.prefixKeys && [...row.prefixKeys],
    }))

    const result = applyPrefixKeymapOverrides(copy, [
      { id: "chat.tab.new", keys: ["n"] },
      { id: "task.new", keys: ["x"] },
    ])

    expect(copy[0]?.prefixKeys).toEqual(["n"])
    expect(copy[0]?.keys).toEqual([])
    expect(result.applied).toEqual([{ id: "chat.tab.new", keys: ["n"], defaultKeys: ["t"] }])
    expect(result.warnings.join("\n")).toContain("not a prefix binding")
  })

  test("preserves the four-slot focus prefix contract", () => {
    const copy = keymap.map((row) => ({
      ...row,
      keys: [...row.keys],
      prefixKeys: row.prefixKeys && [...row.prefixKeys],
    }))
    const result = applyPrefixKeymapOverrides(copy, [{ id: "focus.numeric", keys: ["h"] }])

    expect(copy[2]?.prefixKeys).toEqual(["h", "j", "k", "l"])
    expect(result.warnings.join("\n")).toContain("exactly 4")
  })
})
