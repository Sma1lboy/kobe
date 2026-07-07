/**
 * Toast overlay — bottom-right transient chips.
 *
 * Stacks up to four toasts at a time; newer toasts append at the
 * bottom. Each chip is colored by `kind`:
 *   - `done`        → success (green) — a background tab finished its turn.
 *   - `needs_input` → warning (yellow) — a background tab is paused on
 *                     `AskUserQuestion` / `ExitPlanMode`.
 *   - `error`       → error (red) — a user action failed (e.g. no editor
 *                     found, a worktree/RPC call rejected). Under tmux's
 *                     alternate screen a bare `console.error` is invisible,
 *                     so a failed action surfaces here instead of vanishing
 *                     into the daemon log.
 *
 * Click anywhere on a chip to dismiss it early (its own auto-dismiss
 * timer is owned by the notifications context).
 */

import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"

const MAX_VISIBLE = 4
const CHIP_WIDTH = 40
const RIGHT_MARGIN = 2
const BOTTOM_MARGIN = 2
/** Slide-in: cells the stack starts shifted right by, and the step cadence. */
const SLIDE_CELLS = 6
const SLIDE_STEP_MS = 40

export function ToastOverlay() {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dims = useTerminalDimensions()
  const notif = useNotifications()

  const visibleToasts = () => notif.toasts().slice(-MAX_VISIBLE)

  /* Slide-in on arrival: a NEW newest toast shifts the whole stack
   * SLIDE_CELLS right of its anchor, then steps back to rest over a few
   * frames — the overshoot clips at the screen edge, reading as a slide
   * in from the right. Dismissals don't retrigger (newest id unchanged
   * or the stack empties). */
  const [slide, setSlide] = createSignal(0)
  let lastNewest: string | number | null = null
  createEffect(() => {
    const list = notif.toasts()
    const newest = list.length > 0 ? list[list.length - 1]?.id : null
    if (newest === lastNewest) return
    lastNewest = newest
    if (!newest || themeCtx.reducedMotion) return
    setSlide(SLIDE_CELLS)
    const timer = setInterval(() => {
      setSlide((cur) => {
        const next = Math.max(0, cur - 2)
        if (next === 0) clearInterval(timer)
        return next
      })
    }, SLIDE_STEP_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Anchor the stack to the bottom-right corner. Position is absolute
  // so the overlay sits on top of the Shell layout without taking flow
  // space; `zIndex` keeps it above the panes but below the dialog
  // backdrop (dialogs use 3000).
  const left = () => Math.max(0, dims().width - CHIP_WIDTH - RIGHT_MARGIN) + slide()
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
            const bg = () =>
              toast.kind === "needs_input" ? theme.warning : toast.kind === "error" ? theme.error : theme.success
            // selectedListItemText is the readable foreground over a
            // saturated chip background — same slot the active tab
            // chip uses, so the toast feels native to the tab strip
            // colour vocabulary.
            const fg = () => theme.selectedListItemText
            const prefix = () => (toast.kind === "needs_input" ? "?" : toast.kind === "error" ? "✕" : "✓")
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
