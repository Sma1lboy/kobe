import { describe, expect, test } from "vitest"
import { findBinding } from "../../src/tui/context/keybindings"
import { FIXED_BINDING_IDS } from "../../src/tui/lib/keymap-overrides"

describe("tasks.focusEngine keymap row", () => {
  test("binds Right in the sidebar scope under the Tasks pane category", () => {
    const row = findBinding("tasks.focusEngine")
    expect(row).toBeDefined()
    expect(row?.scope).toBe("sidebar")
    expect(row?.keys).toEqual(["right"])
    expect(row?.category).toBe("Tasks pane")
  })

  test("stays user-overridable (not in FIXED_BINDING_IDS)", () => {
    expect(FIXED_BINDING_IDS["tasks.focusEngine"]).toBeUndefined()
  })
})
