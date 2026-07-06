import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import { ThemeProvider, useTheme } from "../../src/tui/context/theme"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
import { renderComponent } from "./harness"

function Probe() {
  const { theme } = useTheme()
  return <text fg={theme.warning}>WARN</text>
}

function findSpan(frame: CapturedFrame, needle: string) {
  for (const line of frame.lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span
    }
  }
  return undefined
}

describe("ThemeProvider", () => {
  it("defaults to the claude theme and resolves theme.warning to claude's actual warning hex", async () => {
    const { spans } = await renderComponent(() => (
      <ThemeProvider theme="claude">
        <Probe />
      </ThemeProvider>
    ))
    const captured = await spans()
    const span = findSpan(captured, "WARN")
    expect(span).toBeDefined()

    const expectedHex = resolveThemeSlotHex(BUNDLED_THEME_JSONS.claude!, "warning")
    expect(expectedHex).not.toBeNull()
    expect(span?.fg.equals(RGBA.fromHex(expectedHex!))).toBe(true)
  })

  it("selects a non-default bundled theme via the `theme` prop", async () => {
    function SelectedProbe() {
      const { selected } = useTheme()
      return <text>{selected}</text>
    }
    const { frame } = await renderComponent(() => (
      <ThemeProvider theme="dracula">
        <SelectedProbe />
      </ThemeProvider>
    ))
    expect(await frame()).toContain("dracula")
  })
})
