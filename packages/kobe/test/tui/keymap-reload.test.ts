/**
 * `resetKeymapToDefaults` (KOB — live keybinding propagation). The
 * load-bearing half of the live-reload path: on a keybindings.yaml edit the
 * pane resets `KobeKeymap` to its boot-time defaults THEN re-applies the
 * re-read file, so a REMOVED override returns to its default instead of the
 * stale chord sticking around. `applyKeymapOverrides` mutates in place and
 * is additive — without a reset, "defaults + every override ever applied"
 * would pile up. These tests pin the reset (keys AND the cosmetic hint).
 */

import { describe, expect, test } from "vitest"
import { KobeKeymap, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

const ID = "sidebar.rename" // overridable, default ["r"], carries a hint

describe("resetKeymapToDefaults", () => {
  test("Tasks keeps ctrl+q as its direct hard-exit chord", () => {
    expect(findBinding("app.quit")?.keys).toEqual(["q", "ctrl+q"])
    expect(findBinding("app.quit")?.prefixKeys).toBeUndefined()
  })

  test("global navigation keeps direct Ctrl chords alongside prefix aliases", () => {
    expect(findBinding("focus.sidebar")?.keys).toEqual(["ctrl+q"])
    expect(findBinding("focus.sidebar")?.prefixKeys).toEqual(["q"])
    expect(findBinding("focus.numeric")?.keys).toEqual(["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"])
    expect(findBinding("focus.numeric")?.prefixKeys).toEqual(["h", "j", "k", "l"])
  })

  test("non-ChatPane bindings retain their direct Ctrl chords", () => {
    expect(findBinding("sidebar.projectFilter")?.keys).toEqual(["ctrl+p"])
    expect(findBinding("sidebar.projectFilter")?.prefixKeys).toBeUndefined()
    expect(findBinding("terminal.scroll-up")?.keys).toEqual(["ctrl+pageup"])
    expect(findBinding("terminal.scroll-up")?.prefixKeys).toBeUndefined()
  })

  test("terminal scrollback remains a direct ctrl chord outside the ChatPane", () => {
    expect(findBinding("terminal.scroll-up")?.keys).toEqual(["ctrl+pageup"])
    expect(findBinding("terminal.scroll-up")?.prefixKeys).toBeUndefined()
    expect(findBinding("terminal.scroll-down")?.keys).toEqual(["ctrl+pagedown"])
    expect(findBinding("terminal.scroll-down")?.prefixKeys).toBeUndefined()
  })

  test("restores a row's chords + hint after an override", () => {
    const row = findBinding(ID)
    expect(row).toBeDefined()
    const defaultKeys = [...row!.keys]
    const defaultHintKeys = row!.hint?.keys

    applyKeymapOverrides(KobeKeymap, [{ id: ID, keys: ["ctrl+r"] }])
    expect([...findBinding(ID)!.keys]).toEqual(["ctrl+r"])
    expect(findBinding(ID)!.hint?.keys).toBe("ctrl+r")

    resetKeymapToDefaults()
    expect([...findBinding(ID)!.keys]).toEqual(defaultKeys)
    expect(findBinding(ID)!.hint?.keys).toBe(defaultHintKeys)
  })

  test("reset between applies yields defaults+latest, never stacked overrides", () => {
    const defaultKeys = [...findBinding(ID)!.keys]

    applyKeymapOverrides(KobeKeymap, [{ id: ID, keys: ["ctrl+r"] }])
    resetKeymapToDefaults()
    applyKeymapOverrides(KobeKeymap, [{ id: ID, keys: ["ctrl+e"] }])
    // Only the latest override survives — the first didn't accumulate.
    expect([...findBinding(ID)!.keys]).toEqual(["ctrl+e"])

    // And resetting with NO re-apply returns to the pristine default —
    // the "removed override" case the live reload depends on.
    resetKeymapToDefaults()
    expect([...findBinding(ID)!.keys]).toEqual(defaultKeys)
  })
})
