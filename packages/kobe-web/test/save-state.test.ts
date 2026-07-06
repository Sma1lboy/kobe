import { describe, expect, it } from "vitest"
import { type SaveState, saveStatusLabel } from "../src/lib/save-state.ts"

/**
 * The notes autosave chip text. idle renders nothing (the chip is hidden until
 * a save is attempted); the other states each get their own label.
 */

describe("saveStatusLabel", () => {
  it("renders nothing for idle (chip hidden)", () => {
    expect(saveStatusLabel("idle")).toBe("")
  })

  it("labels saving / saved / error", () => {
    expect(saveStatusLabel("saving")).toBe("saving…")
    expect(saveStatusLabel("saved")).toBe("saved")
    expect(saveStatusLabel("error")).toBe("save failed")
  })

  it("covers every SaveState with a defined label", () => {
    const states: SaveState[] = ["idle", "saving", "saved", "error"]
    for (const s of states) expect(typeof saveStatusLabel(s)).toBe("string")
  })
})
