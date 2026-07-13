/** @jsxImportSource @opentui/react */
/**
 * Standalone settings page — keyboard cursor visibility. Navigation only
 * moves `bodyRow` state; on a short terminal the selected row can sit below
 * the fold, so the page's scrollbox must follow it (`scrollChildIntoView`).
 * Regression for the "keyboard focus moves onto invisible controls" gap.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsDialog } from "../../src/tui-react/component/settings-dialog"
import { useKV } from "../../src/tui-react/context/kv"
import { act, renderComponent } from "./harness"

let home: string
const oldHome = process.env.KOBE_HOME_DIR

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-settings-follow-"))
  process.env.KOBE_HOME_DIR = home
})

afterAll(() => {
  if (oldHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = oldHome
  rmSync(home, { recursive: true, force: true })
})

/** Bridges the harness KVProvider into SettingsDialog's kv prop. */
function StandaloneSettings() {
  const kv = useKV()
  return <SettingsDialog kv={kv} standalone onClose={() => {}} />
}

describe("standalone settings keyboard cursor", () => {
  test("navigating below the fold scrolls the selected row into view", async () => {
    const { frame, mockInput } = await renderComponent(<StandaloneSettings />, {
      width: 90,
      height: 12,
      providers: { dialog: true, kv: true },
    })
    const initial = await frame()
    // Sanity: the last General rows start clipped below the 12-row fold.
    expect(initial).not.toContain("Focus accent")

    // Enter the body level, then walk to the bottom row of General.
    await act(async () => mockInput.pressKey("l"))
    await frame()
    let lastFrame = ""
    for (let step = 0; step < 40; step++) {
      await act(async () => mockInput.pressKey("j"))
      lastFrame = await frame()
      if (lastFrame.includes("Focus accent")) break
    }

    // Following the cursor means the lower rows are now inside the viewport
    // instead of the keyboard focus sitting on an invisible control.
    expect(lastFrame).toContain("Focus accent")
  })
})
