import { describe, expect, test } from "vitest"
import { applyPrefixKeymapOverrides, extractPrefixKeybindings } from "../../src/tui/lib/keymap-prefix-overrides"

const keymap = [
  { id: "chat.tab.new", scope: "workspace", keys: [], prefixKeys: ["t"] },
  { id: "task.new", scope: "sidebar", keys: ["n"] },
  { id: "focus.previous", scope: "global", keys: [], prefixKeys: ["h"] },
  { id: "focus.next", scope: "global", keys: ["f4"], prefixKeys: ["l"] },
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

  test("keeps the valid second strokes when a sibling chord in the list is invalid", () => {
    const extracted = extractPrefixKeybindings(
      {
        prefix: { bindings: { "chat.tab.new": ["n", "ctrl+shift+z"] } },
      },
      "linux",
    )

    // The valid "n" survives; only the impossible ctrl+shift+z is dropped.
    expect(extracted.entries).toEqual([{ id: "chat.tab.new", keys: ["n"] }])
    expect(extracted.warnings.join("\n")).toContain("ctrl+shift+z")
    expect(extracted.warnings.join("\n")).not.toContain("keeping the default")
  })

  test("falls back to the default and says so when every chord in the list is invalid", () => {
    const extracted = extractPrefixKeybindings(
      {
        prefix: { bindings: { "chat.tab.new": ["ctrl+shift+z", "cmd+shift+q"] } },
      },
      "linux",
    )

    // No valid chord survived, so the id is not overridden and the default holds.
    expect(extracted.entries).toEqual([])
    expect(extracted.warnings.join("\n")).toContain("no valid chords — keeping the default")
  })

  test("adds declared prefix rows without clearing their direct chords", () => {
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
    expect(copy[1]?.prefixKeys).toEqual(["x"])
    expect(copy[1]?.keys).toEqual(["n"])
    expect(result.applied).toEqual([
      { id: "chat.tab.new", keys: ["n"], defaultKeys: ["t"] },
      { id: "task.new", keys: ["x"], defaultKeys: [] },
    ])
  })

  test("lets relative pane directions be overridden independently", () => {
    const copy = keymap.map((row) => ({
      ...row,
      keys: [...row.keys],
      prefixKeys: row.prefixKeys && [...row.prefixKeys],
    }))
    const result = applyPrefixKeymapOverrides(copy, [
      { id: "focus.previous", keys: ["j"] },
      { id: "focus.next", keys: ["k"] },
    ])

    expect(copy[2]?.prefixKeys).toEqual(["j"])
    expect(copy[3]?.prefixKeys).toEqual(["k"])
    expect(result.warnings).toEqual([])
  })
})
