/**
 * Why this matters: the keymap table is mutated IN PLACE on live reloads —
 * invisible to React. Chord legends re-render only through the version
 * subscription added in G2 (`subscribeKeymapVersion`), which must fire in
 * lockstep with the Solid signal bump or React panes show stale chords
 * after a keybindings.json reload.
 */

import { describe, expect, it } from "vitest"
import { bumpKeymapVersion, keymapVersion, subscribeKeymapVersion } from "../../src/tui/context/keybindings"

describe("keymap version subscription (React side)", () => {
  it("bump notifies subscribers and advances the counter they snapshot", () => {
    const seen: number[] = []
    const unsub = subscribeKeymapVersion(() => seen.push(keymapVersion()))
    const before = keymapVersion()
    bumpKeymapVersion()
    bumpKeymapVersion()
    unsub()
    bumpKeymapVersion()
    expect(seen).toEqual([before + 1, before + 2])
    expect(keymapVersion()).toBe(before + 3)
  })
})
