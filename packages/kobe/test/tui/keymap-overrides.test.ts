/**
 * Unit tests for the user-keybinding override logic
 * (`src/tui/lib/keymap-overrides.ts`) — the pure half of
 * `~/.kobe/settings/keybindings.yaml` support.
 *
 * Why these matter: the override pipeline rewrites `KobeKeymap` in place
 * at boot, so a normalization bug here doesn't crash anything — it
 * silently produces chords `matchKey()` can never mint (binding dead) or
 * bare letters on global scope (binding steals composer typing). The
 * tests pin the two invariants that make overrides safe:
 *   1. normalized chords are EXACTLY the candidate strings
 *      `matchKey()` produces (modifier order ctrl,cmd,alt,shift; no
 *      shift on single characters);
 *   2. the boundary rule from docs/KEYBINDINGS.md (plain letters must be
 *      pane-scoped) is enforced on user input, not just on our defaults.
 *
 * The Bun-only loader (file read + Bun.YAML) is intentionally untested
 * here — vitest runs under node. These tests feed pre-parsed documents.
 */

import { describe, expect, test } from "vitest"
import {
  type OverridableBinding,
  applyKeymapOverrides,
  extractKeybindingOverrides,
  normalizeChord,
} from "../../src/tui/lib/keymap-overrides"

function chordOf(raw: string): string {
  const r = normalizeChord(raw)
  if ("error" in r) throw new Error(`expected ${raw} to normalize, got error: ${r.error}`)
  return r.chord
}

describe("normalizeChord", () => {
  test("canonicalizes modifier aliases and order to match matchKey()", () => {
    expect(chordOf("ctrl+t")).toBe("ctrl+t")
    expect(chordOf("Control+T")).toBe("ctrl+t")
    expect(chordOf("option+meta+x")).toBe("cmd+alt+x") // cmd before alt, like matchKey
    expect(chordOf("shift+tab")).toBe("shift+tab")
    expect(chordOf("alt+ctrl+pageup")).toBe("ctrl+alt+pageup")
  })

  test("key-name aliases: esc → escape, pgup → pageup", () => {
    expect(chordOf("esc")).toBe("escape")
    expect(chordOf("ctrl+pgup")).toBe("ctrl+pageup")
  })

  test("trailing + means the literal plus key", () => {
    expect(chordOf("ctrl++")).toBe("ctrl++")
    expect(chordOf("+")).toBe("+")
  })

  test("a dangling modifier (no key after the +) is an error, not silently Ctrl+Plus", () => {
    for (const raw of ["ctrl+", "cmd+alt+", "ctrl+shift+", "shift+"]) {
      const r = normalizeChord(raw)
      if (!("error" in r)) throw new Error(`expected ${raw} to error, got chord ${r.chord}`)
      expect(r.error).toMatch(/no key after the modifiers/)
    }
  })

  test("accepts bare shift+<char>; rejects shift with other modifiers on a single char", () => {
    expect(chordOf("shift+p")).toBe("shift+p")
    expect(chordOf("P")).toBe("shift+p") // bare uppercase letter is sugar
    expect(chordOf("p")).toBe("p")
    const r = normalizeChord("ctrl+shift+t")
    expect("error" in r).toBe(true)
  })

  test("rejects unknown modifiers and empty chords", () => {
    expect("error" in normalizeChord("hyper+x")).toBe(true)
    expect("error" in normalizeChord("   ")).toBe(true)
  })

  test("unknown multi-char key names apply but warn (may never fire)", () => {
    const r = normalizeChord("ctrl+banana")
    if ("error" in r) throw new Error("should not hard-fail")
    expect(r.chord).toBe("ctrl+banana")
    expect(r.warning).toMatch(/may never fire/)
  })
})

describe("extractKeybindingOverrides", () => {
  test("string, list, and null value forms", () => {
    const { entries, warnings } = extractKeybindingOverrides(
      {
        bindings: {
          "chat.fork.new": "ctrl+g",
          "sidebar.select": ["enter", "space"],
          "files.createPR": null,
        },
      },
      "darwin",
    )
    expect(warnings).toEqual([])
    expect(entries).toContainEqual({ id: "chat.fork.new", keys: ["ctrl+g"] })
    expect(entries).toContainEqual({ id: "sidebar.select", keys: ["enter", "space"] })
    expect(entries).toContainEqual({ id: "files.createPR", keys: [] })
  })

  test("platform overlay replaces the base entry wholesale", () => {
    const doc = {
      bindings: { "palette.open": "ctrl+p" },
      darwin: { bindings: { "palette.open": ["cmd+p"] } },
      linux: { bindings: { "palette.open": ["ctrl+shift+p"] } },
    }
    const mac = extractKeybindingOverrides(doc, "darwin")
    expect(mac.entries).toEqual([{ id: "palette.open", keys: ["cmd+p"] }])
    // The linux section's invalid chord (shift+p is fine — p is preceded
    // by shift but "ctrl+shift+p" has a single-char key) → rejected, so
    // linux keeps the base layer's ctrl+p.
    const linux = extractKeybindingOverrides(doc, "linux")
    expect(linux.entries).toEqual([{ id: "palette.open", keys: ["ctrl+p"] }])
    expect(linux.warnings.length).toBeGreaterThan(0)
  })

  test("macos / mac are accepted aliases for darwin; flat sections work", () => {
    const { entries } = extractKeybindingOverrides({ macos: { "chat.tab.new": "alt+t" } }, "darwin")
    expect(entries).toEqual([{ id: "chat.tab.new", keys: ["alt+t"] }])
  })

  test("empty / non-mapping documents degrade to warnings, never throw", () => {
    expect(extractKeybindingOverrides(null, "darwin").entries).toEqual([])
    expect(extractKeybindingOverrides("nope", "darwin").warnings.length).toBe(1)
    expect(extractKeybindingOverrides({ bindings: 42 }, "darwin").warnings.length).toBe(1)
  })

  test("an entry whose chords ALL fail keeps the default (no entry emitted)", () => {
    const { entries, warnings } = extractKeybindingOverrides(
      { bindings: { "app.quit": ["ctrl+shift+q", "hyper+q"] } },
      "linux",
    )
    expect(entries).toEqual([])
    expect(warnings.some((w) => w.includes("keeping the default"))).toBe(true)
  })
})

describe("applyKeymapOverrides", () => {
  function makeKeymap(): OverridableBinding[] {
    return [
      {
        id: "chat.fork.new",
        scope: "workspace",
        keys: ["ctrl+f"],
        hint: { keys: "ctrl+f" },
      },
      { id: "app.quit", scope: "sidebar", keys: ["q", "ctrl+q"], hint: { keys: "q" } },
      { id: "chat.tab.new", scope: "workspace", keys: ["ctrl+t"] },
      { id: "sidebar.nav", scope: "sidebar", keys: ["j", "k", "down", "up"], hint: { keys: "j/k" } },
      { id: "sidebar.view", scope: "sidebar", keys: ["[", "]"] },
      { id: "sidebar.goto", scope: "sidebar", keys: ["g", "shift+g"] }, // slot pair [top, bottom]
      { id: "chat.question.nav", scope: "workspace", keys: ["j", "k"] }, // FIXED (display-only)
      { id: "chat.send", scope: "workspace", keys: [] }, // doc-only
      { id: "files.createPR", scope: "files", keys: ["p"], hint: { keys: "p" } },
    ]
  }

  test("applies an override, mutating keys and refreshing the hint", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "chat.fork.new", keys: ["ctrl+g"] }])
    expect(warnings).toEqual([])
    expect(applied).toEqual([{ id: "chat.fork.new", keys: ["ctrl+g"], defaultKeys: ["ctrl+f"] }])
    expect(keymap[0]?.keys).toEqual(["ctrl+g"])
    expect(keymap[0]?.hint?.keys).toBe("ctrl+g")
  })

  test("unbind ([]) clears keys AND drops the hint so legends stop advertising it", () => {
    const keymap = makeKeymap()
    const { applied } = applyKeymapOverrides(keymap, [{ id: "files.createPR", keys: [] }])
    expect(applied[0]?.keys).toEqual([])
    const row = keymap.find((b) => b.id === "files.createPR")
    expect(row?.keys).toEqual([])
    expect(row?.hint).toBeUndefined()
  })

  test("unknown ids, fixed ids, and doc-only rows warn without applying", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [
      { id: "nope.nothing", keys: ["ctrl+x"] },
      { id: "chat.question.nav", keys: ["ctrl+n"] }, // FIXED_BINDING_IDS (display-only)
      { id: "chat.send", keys: ["ctrl+m"] }, // doc-only
    ])
    expect(applied).toEqual([])
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toMatch(/unknown binding id/)
    expect(warnings[1]).toMatch(/not customizable/)
    expect(warnings[2]).toMatch(/doc-only/)
    expect(keymap.find((b) => b.id === "chat.question.nav")?.keys).toEqual(["j", "k"])
  })

  test("boundary rule: bare characters are dropped on workspace/global scope, kept on sidebar/files", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [
      { id: "chat.fork.new", keys: ["f"] }, // workspace — must be rejected
      { id: "app.quit", keys: ["x"] }, // sidebar — fine
    ])
    expect(applied).toEqual([{ id: "app.quit", keys: ["x"], defaultKeys: ["q", "ctrl+q"] }])
    expect(warnings.some((w) => w.includes("steal typed input"))).toBe(true)
    expect(warnings.some((w) => w.includes("keeping the default"))).toBe(true)
    expect(keymap.find((b) => b.id === "chat.fork.new")?.keys).toEqual(["ctrl+f"])
  })

  test("conflict with another binding in an overlapping scope warns but still applies", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [
      { id: "chat.fork.new", keys: ["ctrl+t"] }, // collides with chat.tab.new (same scope)
    ])
    expect(applied).toHaveLength(1)
    expect(warnings.some((w) => w.includes("also fires chat.tab.new"))).toBe(true)
  })

  // ─── Slot contracts (direction-multiplexed ids) ──────────────────────
  // sidebar.nav / files.nav / sidebar.search.nav / files.hierarchy /
  // sidebar.view / files.tab dispatch on the matched chord's SLOT
  // (index in the keys array), layout = alternating pairs. Overrides
  // must keep the count even so the slot%2 direction mapping holds —
  // Directional slot groups must preserve their exact positional contract.

  test("slot ids: an even-count override applies (2-chord nav)", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "sidebar.nav", keys: ["w", "s"] }])
    expect(warnings).toEqual([])
    expect(applied).toEqual([{ id: "sidebar.nav", keys: ["w", "s"], defaultKeys: ["j", "k", "down", "up"] }])
    const row = keymap.find((b) => b.id === "sidebar.nav")
    expect(row?.keys).toEqual(["w", "s"])
    expect(row?.hint?.keys).toBe("w/s")
  })

  test("slot ids: a 4-chord override applies too (same pair layout, longer)", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "sidebar.nav", keys: ["w", "s", "down", "up"] }])
    expect(warnings).toEqual([])
    expect(applied).toHaveLength(1)
    expect(keymap.find((b) => b.id === "sidebar.nav")?.keys).toEqual(["w", "s", "down", "up"])
  })

  test("slot ids: an odd-count override warns and keeps the default", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "sidebar.nav", keys: ["w", "s", "x"] }])
    expect(applied).toEqual([])
    expect(warnings.some((w) => w.includes("[down, up]") && w.includes("keeping the default"))).toBe(true)
    expect(keymap.find((b) => b.id === "sidebar.nav")?.keys).toEqual(["j", "k", "down", "up"])
  })

  test("slot ids: app.quit takes 1 or 2 chords, rejects a third", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "app.quit", keys: ["x", "ctrl+x", "ctrl+y"] }])
    expect(applied).toEqual([])
    expect(warnings.some((w) => w.includes("hard exit") && w.includes("keeping the default"))).toBe(true)
    expect(keymap.find((b) => b.id === "app.quit")?.keys).toEqual(["q", "ctrl+q"])
  })

  test("slot ids: a single-chord override of a [prev, next] pair warns and keeps the default", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "sidebar.view", keys: ["ctrl+v"] }])
    expect(applied).toEqual([])
    expect(warnings.some((w) => w.includes("previous view, next view") && w.includes("keeping the default"))).toBe(true)
    expect(keymap.find((b) => b.id === "sidebar.view")?.keys).toEqual(["[", "]"])
  })

  test("slot ids: unbind ([]) is still allowed — no slots involved", () => {
    const keymap = makeKeymap()
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "sidebar.nav", keys: [] }])
    expect(warnings).toEqual([])
    expect(applied).toEqual([{ id: "sidebar.nav", keys: [], defaultKeys: ["j", "k", "down", "up"] }])
    const row = keymap.find((b) => b.id === "sidebar.nav")
    expect(row?.keys).toEqual([])
    expect(row?.hint).toBeUndefined()
  })

  test("slot ids: a partial chord drop (boundary rule) keeps the default instead of shifting slots", () => {
    // Synthetic: a slot-contract id on a workspace scope so the bare-letter
    // rule drops one chord. The production slot ids live on sidebar/files
    // scopes (bare letters fine); this pins the all-or-nothing guard for
    // any future workspace-scope slot id.
    const keymap: OverridableBinding[] = [{ id: "files.nav", scope: "workspace", keys: ["j", "k", "down", "up"] }]
    const { applied, warnings } = applyKeymapOverrides(keymap, [{ id: "files.nav", keys: ["w", "s", "down", "up"] }])
    expect(applied).toEqual([])
    expect(warnings.some((w) => w.includes("steal typed input"))).toBe(true)
    expect(warnings.some((w) => w.includes("shift the slot layout"))).toBe(true)
    expect(keymap[0]?.keys).toEqual(["j", "k", "down", "up"])
  })
})
