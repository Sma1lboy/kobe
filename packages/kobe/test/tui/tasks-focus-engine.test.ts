/**
 * Tasks-pane "Right → focus engine pane" keymap row (tasks.focusEngine).
 *
 * The behavior itself is a tmux `select-pane` against the role-tagged
 * engine pane (verified interactively — pane hosts aren't CI-runnable);
 * what CI pins is the CONTRACT: the row exists in KobeKeymap with the
 * boundary-rule-correct shape, so it stays user-overridable via
 * `~/.kobe/settings/keybindings.yaml` and F1-visible automatically.
 */

import { describe, expect, test } from "vitest"
import { findBinding } from "../../src/tui/context/keybindings"
import { FIXED_BINDING_IDS } from "../../src/tui/lib/keymap-overrides"

describe("tasks.focusEngine keymap row", () => {
  test("binds Right in the sidebar scope under the Tasks pane category", () => {
    const row = findBinding("tasks.focusEngine")
    expect(row).toBeDefined()
    // Sidebar scope = the Tasks pane host's bindByIds block, which gates
    // on no dialog + `/`-search inactive — that gate is what keeps Right
    // working as a cursor key inside the search input.
    expect(row?.scope).toBe("sidebar")
    expect(row?.keys).toEqual(["right"])
    expect(row?.category).toBe("Tasks pane")
  })

  test("stays user-overridable (not in FIXED_BINDING_IDS)", () => {
    expect(FIXED_BINDING_IDS["tasks.focusEngine"]).toBeUndefined()
  })
})
