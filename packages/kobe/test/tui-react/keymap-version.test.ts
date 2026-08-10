import { describe, expect, it } from "vitest"
import { bumpKeymapVersion, subscribeKeymapVersion } from "../../src/tui-react/context/keybindings"
import { keymapVersion } from "../../src/tui/context/keybindings"

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
