/** @jsxImportSource @opentui/react */

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

  const left = Math.max(0, dims.width - CHIP_WIDTH - RIGHT_MARGIN)
  const top = Math.max(0, dims.height - BOTTOM_MARGIN - MAX_VISIBLE - 1)

  return (
    <box position="absolute" zIndex={2500} left={left} top={top} width={CHIP_WIDTH} flexDirection="column" gap={0}>
      {visibleToasts.map((toast) => {
        const bg = toast.kind === "needs_input" ? theme.warning : toast.kind === "error" ? theme.error : theme.success
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
