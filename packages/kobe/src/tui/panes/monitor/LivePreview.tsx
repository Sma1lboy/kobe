/**
 * Live preview pane (v0.6 / KOB-230).
 *
 * Shows the current contents of the selected task's claude tmux pane
 * (via `tmux capture-pane`) on a 1s refresh. The user sees what claude
 * is doing without having to attach — that's the "outer monitor" half
 * of the agent-deck model.
 */

import { For, type JSXElement, Show, createSignal, onCleanup, onMount } from "solid-js"
import { capturePane, stripAnsi } from "../../../monitor/capture-pane.ts"
import { useTheme } from "../../context/theme"
import { tmuxSessionName } from "../terminal/tmux"

const REFRESH_MS = 1000
const MAX_LINES = 200

export interface LivePreviewProps {
  /** Selected task id. `null` shows an empty-state hint. */
  taskId: () => string | null
}

export function LivePreview(props: LivePreviewProps): JSXElement {
  const { theme } = useTheme()
  const [lines, setLines] = createSignal<readonly string[]>([])
  const [empty, setEmpty] = createSignal(false)

  const refresh = async (): Promise<void> => {
    const id = props.taskId()
    if (!id) {
      setLines([])
      setEmpty(true)
      return
    }
    const session = tmuxSessionName(id)
    const text = await capturePane(session)
    // `null` = no claude pane / no session → the empty-state hint is right.
    if (text === null) {
      setLines([])
      setEmpty(true)
      return
    }
    // A live pane (even one momentarily blank mid-repaint) is NOT the
    // no-session state. Keep the previous frame for a blank capture so a
    // transient cleared screen doesn't flash the "press ⏎" hint (KOB-244).
    setEmpty(false)
    if (text.length === 0) return
    const stripped = stripAnsi(text)
    const all = stripped.split("\n")
    // Keep the tail — capture-pane already trimmed to the viewport,
    // but a generous MAX cap protects opentui from huge re-renders if
    // a future caller passes `-S` for full history.
    const tail = all.length > MAX_LINES ? all.slice(-MAX_LINES) : all
    setLines(tail)
  }

  // In-flight dedupe: `capturePane` is a tmux subprocess, so a capture can
  // outlive the 1s cadence under load — and two overlapping refreshes for
  // different tasks can resolve out of order (the OLD task's late frame
  // overwriting the new task's). One run at a time; a tick landing mid-run
  // is dropped and the next tick (≤1s later) catches up. A rejected refresh
  // keeps the last frame instead of surfacing as an unhandled rejection.
  //
  // `lib/background-poll.ts` was considered and rejected here: its keyed,
  // stateless-run contract can't carry this view's keep-last-frame-on-blank
  // merge (the rendered value depends on the previous frame), and its
  // per-key cached signals would change what's shown at the instant of a
  // task switch. See docs/design/app-retirement.md — this pane retires with
  // the outer monitor, so the lighter fix wins.
  let inFlight = false
  const tick = (): void => {
    if (inFlight) return
    inFlight = true
    refresh()
      .catch(() => {})
      .finally(() => {
        inFlight = false
      })
  }

  onMount(() => {
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
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
