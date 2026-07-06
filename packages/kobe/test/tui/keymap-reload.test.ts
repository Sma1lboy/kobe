import { describe, expect, test } from "vitest"
import { KobeKeymap, findBinding, resetKeymapToDefaults } from "../../src/tui/context/keybindings"
import { applyKeymapOverrides } from "../../src/tui/lib/keymap-overrides"

const ID = "sidebar.rename"

describe("resetKeymapToDefaults", () => {
  test("app quit defaults include native two-stage ctrl+q", () => {
    expect(findBinding("app.quit")?.keys).toEqual(["q", "ctrl+q"])
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
    expect([...findBinding(ID)!.keys]).toEqual(["ctrl+e"])

    resetKeymapToDefaults()
    expect([...findBinding(ID)!.keys]).toEqual(defaultKeys)
  })
})
