/** @jsxImportSource @opentui/react */
/**
 * React sidebar hover tooltip (issue #15, G3) — the
 * `src/tui/panes/sidebar/hover-tooltip.tsx` counterpart. Line building and
 * screen-clamped layout are the shared framework-free `hover-layout.ts`.
 */

import { TextAttributes } from "@opentui/core"
import { truncateStart } from "../../../tui/lib/truncate"
import {
  SIDEBAR_HOVER_TOOLTIP_Z_INDEX,
  resolveSidebarHoverTooltipLayout,
  sidebarHoverTooltipLines,
} from "../../../tui/panes/sidebar/hover-layout"
import { truncateTitle } from "../../../tui/panes/sidebar/labels"
import { useTheme } from "../../context/theme"
import type { SidebarHover } from "./types"

export { approxCellWidth } from "../../../tui/panes/sidebar/hover-layout"

export function SidebarHoverTooltip(props: {
  hover: SidebarHover | null
  dims: { width: number; height: number }
}) {
  const { theme } = useTheme()
  const hover = props.hover
  if (!hover) return null
  const lines = sidebarHoverTooltipLines(hover)
  const layout = resolveSidebarHoverTooltipLayout({
    hoverX: hover.x,
    hoverY: hover.y,
    screenWidth: props.dims.width,
    screenHeight: props.dims.height,
    lines,
  })
  return (
    <box
      position="absolute"
      zIndex={SIDEBAR_HOVER_TOOLTIP_Z_INDEX}
      left={layout.left}
      top={layout.top}
      width={layout.boxWidth}
      flexDirection="column"
      border
      borderColor={theme.focusAccent}
      backgroundColor={theme.backgroundElement}
      paddingLeft={1}
      paddingRight={1}
    >
      {lines.map((line) => (
        <text
          key={line.text}
          fg={line.dim ? theme.textMuted : theme.text}
          attributes={line.bold ? TextAttributes.BOLD : line.dim ? TextAttributes.DIM : undefined}
          wrapMode="none"
        >
          {line.dim ? truncateStart(line.text, layout.innerWidth) : truncateTitle(line.text, layout.innerWidth)}
        </text>
      ))}
    </box>
  )
}
