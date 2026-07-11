/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import { FileTreeRowView } from "../../src/tui-react/panes/filetree/row-view"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
import { renderComponent } from "./harness"

function findSpan(frame: CapturedFrame, needle: string) {
  return frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes(needle))
}

describe("FileTreeRowView", () => {
  it("uses the shared neutral cursor marker instead of the pane focus accent", async () => {
    const text = RGBA.fromHex(resolveThemeSlotHex(BUNDLED_THEME_JSONS.claude!, "text")!)
    const focusAccent = RGBA.fromHex(resolveThemeSlotHex(BUNDLED_THEME_JSONS.claude!, "primary")!)
    const { destroy, spans } = await renderComponent(
      <FileTreeRowView
        row={{ kind: "dir", path: ".agents", name: ".agents", depth: 0, expanded: false, hasChildren: true }}
        index={0}
        cursor
        statWidths={{ added: 0, deleted: 0 }}
        pathBudget={30}
        onActivate={() => {}}
      />,
      { width: 36, height: 4 },
    )

    try {
      const marker = findSpan(await spans(), "▌")
      expect(marker?.fg.equals(text)).toBe(true)
      expect(marker?.fg.equals(focusAccent)).toBe(false)
    } finally {
      destroy()
    }
  })
})
