import { describe, expect, it } from "vitest"
import {
  SIDEBAR_HOVER_TOOLTIP_Z_INDEX,
  approxCellWidth,
  resolveSidebarHoverTooltipLayout,
} from "../../src/tui/panes/sidebar/hover-layout"

describe("sidebar hover tooltip layout", () => {
  it("uses an overlay layer above pane chrome and toast overlays", () => {
    expect(SIDEBAR_HOVER_TOOLTIP_Z_INDEX).toBeGreaterThan(2500)
  })

  it("clamps the tooltip inside the screen", () => {
    const layout = resolveSidebarHoverTooltipLayout({
      hoverX: 78,
      hoverY: 22,
      screenWidth: 80,
      screenHeight: 24,
      lines: [{ text: "a long hovered task title" }, { text: "/tmp/repo/worktree", dim: true }],
    })
    expect(layout.left + layout.boxWidth).toBeLessThan(80)
    expect(layout.top + layout.boxHeight).toBeLessThan(24)
  })

  it("sizes using terminal cell width for CJK text", () => {
    expect(approxCellWidth("kobe")).toBe(4)
    expect(approxCellWidth("任务")).toBe(4)
  })
})
