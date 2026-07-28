import { describe, expect, it } from "vitest"
import { extractPluginKeybindings } from "../../src/tui/lib/keymap-plugin-bindings"

describe("extractPluginKeybindings", () => {
  it("parses pane: and action: values with normalized chords", () => {
    const { entries, warnings } = extractPluginKeybindings(
      { plugins: { "Ctrl+G": "pane:examples.lazygit.git", f6: "action: examples.notify.test" } },
      "darwin",
    )
    expect(entries).toEqual([
      { chord: "ctrl+g", kind: "pane", target: "examples.lazygit.git" },
      { chord: "f6", kind: "action", target: "examples.notify.test" },
    ])
    expect(warnings).toEqual([])
  })

  it("platform overlay wins per chord", () => {
    const { entries } = extractPluginKeybindings(
      {
        plugins: { "ctrl+g": "pane:examples.lazygit.git" },
        darwin: { plugins: { "ctrl+g": "action:examples.notify.test" } },
      },
      "darwin",
    )
    expect(entries).toEqual([{ chord: "ctrl+g", kind: "action", target: "examples.notify.test" }])
    // A different platform ignores the overlay.
    const linux = extractPluginKeybindings({ plugins: { "ctrl+g": "pane:examples.lazygit.git" } }, "linux")
    expect(linux.entries[0]?.kind).toBe("pane")
  })

  it("warns and skips malformed values and bad chords", () => {
    const { entries, warnings } = extractPluginKeybindings(
      {
        plugins: {
          "ctrl+g": "examples.lazygit.git", // missing pane:/action: prefix
          "": "pane:examples.lazygit.git", // empty chord
          f7: { pane: "x" }, // non-string value
        },
      },
      "linux",
    )
    expect(entries).toEqual([])
    expect(warnings).toHaveLength(3)
  })

  it("returns empty for docs without a plugins section", () => {
    expect(extractPluginKeybindings({}, "darwin").entries).toEqual([])
    expect(extractPluginKeybindings(null, "darwin").entries).toEqual([])
  })
})
