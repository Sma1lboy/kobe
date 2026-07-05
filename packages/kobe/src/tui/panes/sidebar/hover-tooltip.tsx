import { TextAttributes } from "@opentui/core"
import type { Accessor } from "solid-js"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../../context/theme"
import { truncateStart } from "../../lib/truncate"
import {
  SIDEBAR_HOVER_TOOLTIP_Z_INDEX,
  resolveSidebarHoverTooltipLayout,
  sidebarHoverTooltipLines,
} from "./hover-layout"
import { truncateTitle } from "./labels"
import type { SidebarHover } from "./types"

export { approxCellWidth } from "./hover-layout"

export function SidebarHoverTooltip(props: {
  hover: Accessor<SidebarHover | null>
  dims: Accessor<{ width: number; height: number }>
}) {
  const { theme } = useTheme()

  return (
    <Show when={props.hover()}>
      {(hover) => {
        const lines = createMemo(() => sidebarHoverTooltipLines(hover()))
        const layout = createMemo(() =>
          resolveSidebarHoverTooltipLayout({
            hoverX: hover().x,
            hoverY: hover().y,
            screenWidth: props.dims().width,
            screenHeight: props.dims().height,
            lines: lines(),
          }),
        )
        return (
          <box
            position="absolute"
            zIndex={SIDEBAR_HOVER_TOOLTIP_Z_INDEX}
            left={layout().left}
            top={layout().top}
            width={layout().boxWidth}
            flexDirection="column"
            border
            borderColor={theme.focusAccent}
            backgroundColor={theme.backgroundElement}
            paddingLeft={1}
            paddingRight={1}
          >
            <For each={lines()}>
              {(line) => (
                <text
                  fg={line.dim ? theme.textMuted : theme.text}
                  attributes={line.bold ? TextAttributes.BOLD : line.dim ? TextAttributes.DIM : undefined}
                  wrapMode="none"
                >
                  {line.dim
                    ? truncateStart(line.text, layout().innerWidth)
                    : truncateTitle(line.text, layout().innerWidth)}
                </text>
              )}
            </For>
          </box>
        )
      }}
    </Show>
  )
}
