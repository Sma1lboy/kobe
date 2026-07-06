/** @jsxImportSource @opentui/react */
/**
 * Toast overlay (React port of `src/tui/component/toast-overlay.tsx`,
 * issue #15 G3) — bottom-right transient chips, colored by kind
 * (done→success, needs_input→warning, error→red), newest at the bottom,
 * up to four visible, click to dismiss early. Auto-dismiss timers stay
 * owned by the notifications context; full rationale in the Solid header.
 */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"

const MAX_VISIBLE = 4
const CHIP_WIDTH = 40
const RIGHT_MARGIN = 2
const BOTTOM_MARGIN = 2

export function ToastOverlay() {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()
  const notif = useNotifications()

  if (notif.toasts.length === 0) return null
  const visibleToasts = notif.toasts.slice(-MAX_VISIBLE)

  // Anchor the stack to the bottom-right corner. Position is absolute so
  // the overlay sits on top of the layout without taking flow space;
  // `zIndex` keeps it above the panes but below the dialog backdrop (3000).
  const left = Math.max(0, dims.width - CHIP_WIDTH - RIGHT_MARGIN)
  const top = Math.max(0, dims.height - BOTTOM_MARGIN - MAX_VISIBLE - 1)

  return (
    <box position="absolute" zIndex={2500} left={left} top={top} width={CHIP_WIDTH} flexDirection="column" gap={0}>
      {visibleToasts.map((toast) => {
        const bg = toast.kind === "needs_input" ? theme.warning : toast.kind === "error" ? theme.error : theme.success
        // selectedListItemText is the readable foreground over a saturated
        // chip background — same slot the active tab chip uses.
        const fg = theme.selectedListItemText
        const prefix = toast.kind === "needs_input" ? "?" : toast.kind === "error" ? "✕" : "✓"
        return (
          <box
            key={toast.id}
            flexDirection="row"
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={bg}
            onMouseUp={() => notif.dismiss(toast.id)}
          >
            <text fg={fg} attributes={TextAttributes.BOLD} wrapMode="none">
              {prefix}
            </text>
            <text fg={fg} wrapMode="none">
              {toast.title}
            </text>
          </box>
        )
      })}
    </box>
  )
}
