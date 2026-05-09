/**
 * Wave 3 Stream G — animated thinking/streaming indicator.
 *
 * Why this exists: the prior chat-placeholder rendered a static `…`
 * while waiting for the engine. Users (Jackson included) thought it
 * was hung when Claude Code took 5–15s to start a turn. A visible
 * animation answers "are we still alive?" without burning attention.
 *
 * Visual style — ported from opcode (`refs/opcode/src/components/
 * claude-code-session/MessageList.tsx:148-150`):
 *
 *     <div className="h-2 w-2 bg-primary rounded-full animate-pulse" />
 *     <span>Claude is thinking...</span>
 *
 * Their dot pulses via CSS `animate-pulse`. opentui has no CSS — we
 * substitute a 10-frame braille spinner cycling on a 80ms interval.
 * Same vibe, terminal-native. The label "thinking" matches opcode's
 * copy verbatim because (a) it's already familiar to users coming
 * from Claude Code GUI flows, and (b) the brief asked us to "just
 * copy it directly" within reason.
 *
 * Implementation notes:
 *
 *   - We use `createSignal` + `setInterval` rather than opentui's
 *     `useTimeout` because the latter is a one-shot. `setInterval`
 *     gives us a continuous tick; `onCleanup` clears it when the
 *     component unmounts (task switch, chat close, etc.).
 *   - The frame array is module-scoped; no allocation per tick.
 *   - 80ms is borrowed from the cli-spinners package's `dots`
 *     preset — fast enough to feel alive, slow enough not to chew
 *     CPU on terminals that re-render the whole pane on each frame.
 */

import { createSignal, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"

/**
 * Standard braille dots-spinner. Same character set used by `cli-spinners`
 * → `dots` (the most popular spinner in the Node TUI ecosystem). We pick
 * this over the simpler `["⋯", "⋮"]` cycle because the smoother gradient
 * reads better in a 24-row terminal where every animation frame is the
 * user's full attention span.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Tick interval. 80ms ≈ 12.5fps — visible motion without busy-loop. */
const FRAME_MS = 80

export interface LoadingProps {
  /**
   * Optional label override. Defaults to "thinking" to match opcode's
   * "Claude is thinking…" copy without the redundant "Claude is" prefix
   * (the chat header already says we're talking to Claude).
   */
  label?: string
}

/**
 * Animated thinking indicator. Renders as `<spinner> <label>` on a
 * single line in `theme.textMuted` so it doesn't compete with the
 * actual message content. Self-contained — drop it anywhere the
 * chat wants to say "we're working on it."
 */
export function Loading(props: LoadingProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)

  // Tick the frame index on a fixed interval. We use modular increment
  // so the index stays small forever (no overflow concern in a TUI's
  // lifetime, but tidy is tidy).
  const handle = setInterval(() => {
    setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
  }, FRAME_MS)

  onCleanup(() => {
    clearInterval(handle)
  })

  return (
    <box flexDirection="row" gap={1} paddingTop={1}>
      <text fg={theme.accent}>{SPINNER_FRAMES[frame()] ?? SPINNER_FRAMES[0]}</text>
      <text fg={theme.textMuted}>{props.label ?? "thinking"}</text>
    </box>
  )
}
