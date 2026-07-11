/** @jsxImportSource @opentui/react */

import { describe, expect, test } from "bun:test"
import { KeybindingsSettingsSection } from "../../src/tui-react/component/settings-dialog/sections-misc"
import { renderComponent } from "./harness"

describe("KeybindingsSettingsSection prefix settings", () => {
  test("shows the PureTUI prefix example and active default", async () => {
    const { frame } = await renderComponent(<KeybindingsSettingsSection />, { width: 120, height: 60 })

    const text = await frame()
    expect(text).toContain("PureTUI prefix")
    expect(text).toContain("ctrl+a")
    expect(text).toContain("timeoutMs")
    expect(text).toContain("chat.tab.new: t")
  })
})
