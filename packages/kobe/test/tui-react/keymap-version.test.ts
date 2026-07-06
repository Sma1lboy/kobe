import { describe, expect, it } from "vitest"
import {
  bindByIds,
  bumpKeymapVersion,
  chordsOf,
  findBinding,
  subscribeKeymapVersion,
} from "../../src/tui-react/context/keybindings"
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

describe("react keybindings re-exports", () => {
  it("exposes the shared keymap data + lookups (same objects as the Solid module)", () => {
    const anyBinding = findBinding("app.quit") ?? findBinding("sidebar.up")
    expect(Array.isArray(chordsOf(anyBinding?.id ?? "app.quit"))).toBe(true)
    expect(bindByIds({})).toEqual([])
  })
})
