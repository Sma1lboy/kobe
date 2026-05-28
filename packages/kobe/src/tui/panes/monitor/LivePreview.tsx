/**
 * Live preview pane (v0.6 / KOB-230).
 *
 * Shows the current contents of the selected task's claude tmux pane
 * (via `tmux capture-pane`) on a 1s refresh. The user sees what claude
 * is doing without having to attach — that's the "outer monitor" half
 * of the agent-deck model.
 *
 * Filling the box (KOB-244): the claude pane is only ~47% of the inner
 * tmux window (the Tasks / Ops / shell panes take the rest), so a naive
 * capture leaves the wide preview box half-empty. We measure this box
 * and — ONLY while no client is attached to the session — `resize-window`
 * the inner window so the claude pane is about as wide as the box, then
 * capture. `window-size` stays `latest`, so the moment the user attaches
 * (⏎) tmux resizes the window back to their real terminal; the preview
 * resize only sticks while detached, never fighting a live session.
 */

import { resizeWindow, sessionHasClient } from "@/tmux/client"
import { CLAUDE_PANE_PERCENT, TASKS_PANE_PERCENT } from "@/tmux/session-layout"
import type { BoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, type JSXElement, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { capturePane, stripAnsi } from "../../../monitor/capture-pane.ts"
import { useTheme } from "../../context/theme"
import { tmuxSessionName } from "../terminal/tmux"

const REFRESH_MS = 1000
const MAX_LINES = 200

/**
 * The claude pane's share of the tmux window, derived from the layout:
 * the Tasks pane takes the left `TASKS_PANE_PERCENT`, then claude keeps
 * `CLAUDE_PANE_PERCENT` of what's left. We size the window to
 * `boxWidth / CLAUDE_FRACTION` so the captured claude pane ≈ the box.
 */
const CLAUDE_FRACTION = (1 - TASKS_PANE_PERCENT / 100) * (CLAUDE_PANE_PERCENT / 100)

export interface LivePreviewProps {
  /** Selected task id. `null` shows an empty-state hint. */
  taskId: () => string | null
}

export function LivePreview(props: LivePreviewProps): JSXElement {
  const { theme } = useTheme()
  const [lines, setLines] = createSignal<readonly string[]>([])
  const [empty, setEmpty] = createSignal(false)
  const [boxRef, setBoxRef] = createSignal<BoxRenderable | null>(null)
  const [box, setBox] = createSignal<{ w: number; h: number } | null>(null)
  const dims = useTerminalDimensions()
  const [geomTick, setGeomTick] = createSignal(0)

  // Catch layout changes (e.g. a sidebar splitter drag) that resize this
  // box without their own Solid signal — same pattern as Terminal.tsx.
  const geomTimer = setInterval(() => setGeomTick((n) => (n + 1) & 0xff), 1000)
  onCleanup(() => clearInterval(geomTimer))

  // Measure the rendered box. `ref.width/height` are the box's cell dims;
  // subtract the box's own paddingLeft/Right (1+1) for the usable width.
  createEffect(() => {
    const ref = boxRef()
    dims()
    geomTick()
    if (!ref) return
    const w = Math.max(20, ref.width - 2)
    const h = Math.max(4, ref.height)
    setBox((cur) => (cur && cur.w === w && cur.h === h ? cur : { w, h }))
  })

  const refresh = async (): Promise<void> => {
    const id = props.taskId()
    if (!id) {
      setLines([])
      setEmpty(true)
      return
    }
    const session = tmuxSessionName(id)
    const b = box()
    // Widen the inner window so the claude pane fills the box — but only
    // when nobody is attached (don't resize a session being worked in).
    if (b && !(await sessionHasClient(session))) {
      await resizeWindow(session, Math.ceil(b.w / CLAUDE_FRACTION), b.h + 1)
    }
    const text = await capturePane(session)
    // `null` = no claude pane / no session → the empty-state hint is right.
    if (text === null) {
      setLines([])
      setEmpty(true)
      return
    }
    // A live pane (even one momentarily blank mid-repaint) is NOT the
    // no-session state. Keep the previous frame for a blank capture so a
    // transient cleared screen doesn't flash the "press ⏎" hint.
    setEmpty(false)
    if (text.length === 0) return
    const width = b?.w
    const all = stripAnsi(text)
      .split("\n")
      // Truncate to the box width so an over-wide capture can't soft-wrap
      // each line into two rows (the resize aims for ≈ box width).
      .map((line) => (width ? line.slice(0, width) : line))
    const tail = all.length > MAX_LINES ? all.slice(-MAX_LINES) : all
    setLines(tail)
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box ref={(r: BoxRenderable) => setBoxRef(r)} flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <Show
        when={!empty()}
        fallback={
          <box flexGrow={1} alignItems="center" justifyContent="center">
            <text fg={theme.textMuted}>No live preview — press ⏎ to enter the task and start a claude session.</text>
          </box>
        }
      >
        <For each={lines()}>{(line) => <text fg={theme.textMuted}>{line.length === 0 ? " " : line}</text>}</For>
      </Show>
    </box>
  )
}
