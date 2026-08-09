/**
 * Unit tests for the keyboard-discoverability hint assembly
 * (`src/tui/lib/keyboard-hints.ts`). The contract that matters: every hint
 * resolves through the LIVE keymap and reachability snapshot — a rebound
 * chord shows its new key, an unbound/disabled one drops its token, and the
 * terminal passthrough boundary is never lied about (the prefix first
 * stroke belongs to the PTY there).
 */

import { afterEach, describe, expect, test } from "vitest"
import { findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings.ts"
import { paneHintTokens, paneHintVisible, statusHintTokens, wizardKeyLines } from "../../src/tui/lib/keyboard-hints.ts"
import type { BindingReachability } from "../../src/tui/lib/keymap-dispatch.ts"

afterEach(() => resetKeymapToDefaults())

function reach(
  overrides: Partial<{ direct: string[]; prefix: string[]; inputPassthrough: boolean }> = {},
): BindingReachability {
  return {
    direct: new Set(overrides.direct ?? []),
    prefix: new Set(overrides.prefix ?? []),
    inputPassthrough: overrides.inputPassthrough ?? false,
  }
}

/** Rebind a keymap row in place, the same mutation the override path does. */
function rebind(id: string, keys: string[], hint?: string): void {
  const row = findBinding(id)
  if (!row) throw new Error(`unknown binding ${id}`)
  const mutable = row as { keys: readonly string[]; hint?: { keys: string } }
  mutable.keys = keys
  if (hint === undefined) mutable.hint = undefined
  else mutable.hint = { keys: hint }
}

describe("statusHintTokens", () => {
  test("advertises the prefix and help chord when both are reachable", () => {
    const tokens = statusHintTokens(reach({ direct: ["help.open"], prefix: ["settings.open"] }), "ctrl+a")
    expect(tokens).toEqual([
      { chord: "ctrl+a", msg: "commands" },
      { chord: "F1", msg: "help" },
    ])
  })

  test("terminal passthrough swaps the prefix token for the escape hatch", () => {
    const tokens = statusHintTokens(
      reach({ direct: ["focus.sidebar", "help.open"], prefix: [], inputPassthrough: true }),
      "ctrl+a",
    )
    expect(tokens.map((t) => t.msg)).toEqual(["sidebar", "help"])
    expect(tokens[0]?.chord).toBe("ctrl+q")
  })

  test("a disabled prefix drops its token instead of teaching a dead key", () => {
    const tokens = statusHintTokens(reach({ direct: ["help.open"], prefix: ["settings.open"] }), null)
    expect(tokens.map((t) => t.msg)).toEqual(["help"])
  })

  test("no reachable prefix bindings (modal barrier) drops the prefix token", () => {
    const tokens = statusHintTokens(reach({ direct: ["help.open"], prefix: [] }), "ctrl+a")
    expect(tokens.map((t) => t.msg)).toEqual(["help"])
  })

  test("an unreachable help chord drops its token; nothing left → empty", () => {
    expect(statusHintTokens(reach(), null)).toEqual([])
  })

  test("a rebound help chord advertises the user's key, not the default", () => {
    rebind("help.open", ["f9"], "F9")
    const tokens = statusHintTokens(reach({ direct: ["help.open"] }), null)
    expect(tokens).toEqual([{ chord: "F9", msg: "help" }])
  })
})

describe("paneHintTokens", () => {
  test("sidebar first-use hint teaches nav/select from live caps", () => {
    expect(paneHintTokens("sidebar", "firstUse")).toEqual([
      { cap: "j/k", msg: "move" },
      { cap: "enter", msg: "open" },
    ])
  })

  test("sidebar has no permanent hint line after first use", () => {
    expect(paneHintTokens("sidebar", "always")).toEqual([])
  })

  test("files keeps its open/diff pair as the permanent short set", () => {
    const caps = paneHintTokens("files", "always").map((t) => t.msg)
    expect(caps).toEqual(["open", "diff"])
    expect(paneHintTokens("files", "firstUse").map((t) => t.msg)).toEqual(["move", "fold", "open", "diff"])
  })

  test("an unbound row drops out of the hint instead of advertising a dead chord", () => {
    rebind("sidebar.select", [])
    expect(paneHintTokens("sidebar", "firstUse").map((t) => t.msg)).toEqual(["move"])
  })
})

describe("paneHintVisible", () => {
  test("default state (nothing persisted) shows the hint", () => {
    expect(paneHintVisible(undefined, undefined)).toBe(true)
  })
  test("using the pane's keys extinguishes it", () => {
    expect(paneHintVisible(undefined, true)).toBe(false)
  })
  test("the master toggle silences everything", () => {
    expect(paneHintVisible(false, false)).toBe(false)
  })
})

describe("wizardKeyLines", () => {
  test("teaches all four grammar lines from the default keymap", () => {
    const lines = wizardKeyLines("ctrl+a")
    expect(lines.map((l) => l.msg)).toEqual(["keysBare", "keysOnePress", "keysPrefix", "keysHelp"])
    expect(lines[0]?.params).toEqual({ nav: "j/k", open: "⏎" })
    expect(lines[2]?.params.prefix).toBe("⌃ A")
  })

  test("a disabled prefix drops the prefix line", () => {
    expect(wizardKeyLines(null).map((l) => l.msg)).toEqual(["keysBare", "keysOnePress", "keysHelp"])
  })

  test("unbinding an example chord drops its whole line", () => {
    rebind("chat.tab.new", [])
    expect(wizardKeyLines("ctrl+a").map((l) => l.msg)).toEqual(["keysBare", "keysPrefix", "keysHelp"])
  })
})
