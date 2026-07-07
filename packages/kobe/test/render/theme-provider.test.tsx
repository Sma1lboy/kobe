/** @jsxImportSource @opentui/react */
/**
 * ThemeProvider — theme context (src/tui-react/context/theme.tsx). Pure
 * hex-resolution already has vitest coverage (theme-core.ts has no @opentui
 * import); this covers the piece that DOES import @opentui/react and so can't
 * run under vitest: the live `useTheme()` wiring — the default theme, a
 * resolved color actually reaching a rendered cell, and theme selection via
 * the `theme` prop. React delta: `theme` is a PLAIN resolved object.
 *
 * The harness's default ThemeProvider is disabled here (`theme: false`) so each
 * test owns the single module-level theme store without a nested wrapper.
 */
import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import { ThemeProvider, useTheme } from "../../src/tui-react/context/theme"
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
    const { spans } = await renderComponent(
      <ThemeProvider theme="claude">
        <Probe />
      </ThemeProvider>,
      { providers: { theme: false } },
    )
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
    const { frame } = await renderComponent(
      <ThemeProvider theme="dracula">
        <SelectedProbe />
      </ThemeProvider>,
      { providers: { theme: false } },
    )
    expect(await frame()).toContain("dracula")
  })
})
