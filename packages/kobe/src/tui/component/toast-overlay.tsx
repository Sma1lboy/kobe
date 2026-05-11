/**
 * Toast overlay — bottom-right transient chips.
 *
 * Stacks up to four toasts at a time; newer toasts append at the
 * bottom. Each chip is colored by `kind`:
 *   - `done`        → success (green) — a background tab finished its turn.
 *   - `needs_input` → warning (yellow) — a background tab is paused on
 *                     `AskUserQuestion` / `ExitPlanMode`.
 *
 * Click anywhere on a chip to dismiss it early (its own auto-dismiss
 * timer is owned by the notifications context).
 */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
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

  const visibleToasts = () => notif.toasts().slice(-MAX_VISIBLE)

  // Anchor the stack to the bottom-right corner. Position is absolute
  // so the overlay sits on top of the Shell layout without taking flow
  // space; `zIndex` keeps it above the panes but below the dialog
  // backdrop (dialogs use 3000).
  const left = () => Math.max(0, dims().width - CHIP_WIDTH - RIGHT_MARGIN)
  const top = () => Math.max(0, dims().height - BOTTOM_MARGIN - MAX_VISIBLE - 1)

  return (
    <Show when={notif.toasts().length > 0}>
      <box
        position="absolute"
        zIndex={2500}
        left={left()}
        top={top()}
        width={CHIP_WIDTH}
        flexDirection="column"
        gap={0}
      >
        <For each={visibleToasts()}>
          {(toast) => {
            const bg = () => (toast.kind === "needs_input" ? theme.warning : theme.success)
            // selectedListItemText is the readable foreground over a
            // saturated chip background — same slot the active tab
            // chip uses, so the toast feels native to the tab strip
            // colour vocabulary.
            const fg = () => theme.selectedListItemText
            const prefix = () => (toast.kind === "needs_input" ? "?" : "✓")
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={bg()}
                onMouseUp={() => notif.dismiss(toast.id)}
              >
                <text fg={fg()} attributes={TextAttributes.BOLD} wrapMode="none">
                  {prefix()}
                </text>
                <text fg={fg()} wrapMode="none">
                  {toast.title}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}
