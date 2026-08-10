import { describe, expect, it } from "vitest"
import { resolveRowSelectionChrome } from "../../src/tui-react/ui/row-selection-chrome"
import { BUNDLED_THEMES, applyDisplayOverlay, resolveTheme } from "../../src/tui/context/theme-core"

const theme = resolveTheme(BUNDLED_THEMES.claude as never, "dark")
const transparentTheme = applyDisplayOverlay(theme, "primary", true)

describe("resolveRowSelectionChrome", () => {
  it("uses a neutral marker and element tint for the movable cursor", () => {
    expect(resolveRowSelectionChrome(theme, { cursor: true })).toEqual({
      marker: "▌",
      markerColor: theme.text,
      backgroundColor: theme.backgroundElement,
    })
  })

  it("keeps a persistent selection visible without borrowing pane focus", () => {
    expect(resolveRowSelectionChrome(theme, { cursor: false, selected: true })).toEqual({
      marker: "▌",
      markerColor: theme.borderActive,
      backgroundColor: theme.background,
    })
  })

  it("lets the cursor win when it also sits on the selected row", () => {
    expect(resolveRowSelectionChrome(theme, { cursor: true, selected: true }).markerColor).toBe(theme.text)
  })

  it("drops every background fill in transparent mode and moves the cursor signal to an accent marker", () => {
    expect(resolveRowSelectionChrome(transparentTheme, { cursor: true })).toEqual({
      marker: "▌",
      markerColor: transparentTheme.focusAccent,
      backgroundColor: undefined,
    })
    expect(resolveRowSelectionChrome(transparentTheme, { cursor: false, selected: true }).backgroundColor).toBe(
      undefined,
    )
  })
})
