/** @jsxImportSource @opentui/react */
/**
 * Real-render coverage for the Settings dialog: mount the actual component,
 * walk every section with the real `j` chord, and assert each section's own
 * body content — including the localized Keybindings command-layer block
 * with its live prefix/timeout values.
 */

import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SettingsDialog } from "../../src/tui-react/component/settings-dialog"
import { useKV } from "../../src/tui-react/context/kv"
import { act, renderComponent, settle } from "./harness"

const NOOP = (): void => {}

function Driver() {
  const kv = useKV()
  return <SettingsDialog kv={kv} onClose={NOOP} />
}

describe("SettingsDialog", () => {
  it("walks every section with the real j chord and renders each body", async () => {
    const home = mkdtempSync(join(tmpdir(), "kobe-settings-"))
    process.env.KOBE_HOME_DIR = home
    const { frame, mockInput } = await renderComponent(<Driver />, {
      width: 110,
      height: 40,
      providers: { kv: true, dialog: true },
    })

    // General opens first: theme list + the keyboard-hints toggle.
    let text = await frame()
    expect(text).toContain("Theme")
    expect(text).toContain("Show keyboard hints")

    const press = async (key: string): Promise<string> => {
      act(() => mockInput.pressKey(key))
      await settle()
      return await frame()
    }

    text = await press("j") // → Engines
    expect(text).toContain("Launch command")
    text = await press("j") // → Accounts
    expect(text).toContain("Read-only view of locally-detected engine accounts")
    text = await press("j") // → Plugins
    expect(text).toContain("No plugins registered")
    text = await press("j") // → Keybindings
    expect(text).toContain("Command layer (ctrl+a)")
    expect(text).toContain("Prefix key: ctrl+a")
    expect(text).toContain("5000ms second-stroke window")
    expect(text).not.toContain("Fixed (not rebindable)") // FIXED_BINDING_IDS is empty
    await press("l")
    act(() => mockInput.pressEnter())
    await settle()
    text = await frame()
    expect(text).toContain("Command prefix")
    act(() => {
      for (let i = 0; i < "ctrl+a".length; i++) mockInput.pressBackspace()
      mockInput.typeText("ctrl+b")
    })
    act(() => mockInput.pressEnter())
    await settle()
    text = await frame()
    expect(text).toContain("Command layer (ctrl+b)")
    expect(readFileSync(join(home, ".rove", "settings", "keybindings.yaml"), "utf8")).toContain("key: ctrl+b")
    await press("h")
    text = await press("j") // → Feedback
    expect(text).toContain("GitHub Discussion")
    text = await press("j") // → Dev
    expect(text).toContain("Reset UI state")
  })
})
