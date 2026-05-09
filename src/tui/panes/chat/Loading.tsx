/**
 * Wave 3 Stream G — animated thinking/streaming indicator.
 *
 * Originally ported from opcode's `MessageList.tsx:148-150`
 * (`animate-pulse` dot + "Claude is thinking..."). Wave 4 refresh
 * brings this in line with Claude Code's own spinner — the glyph set
 * comes from `refs/claude-code/src/components/Spinner/utils.ts:4-11`
 * and the cycle pattern (forward then reverse) from
 * `refs/claude-code/src/components/Spinner/SpinnerGlyph.tsx:7`.
 *
 * Why this matters: the brief asks for kobe to "feel like Claude Code,
 * not a third-party shell." The braille dots are well-known but
 * generic; Claude Code's `· ✢ ✳ ✶ ✻ ✽` cycle is distinctive enough
 * that a user who grew up on the official CLI will recognize it. We
 * keep the same forward+reverse cycle so the asterisk "blooms" and
 * "deflates" instead of jumping back to the dot every frame.
 *
 * Implementation notes:
 *
 *   - `createSignal` + `setInterval` rather than opentui's
 *     `useTimeout` because the latter is a one-shot. `setInterval`
 *     gives us a continuous tick; `onCleanup` clears it when the
 *     component unmounts (task switch, chat close, etc.).
 *   - The frame array is module-scoped; no allocation per tick.
 *   - 120ms is a slightly slower cadence than opcode's 80ms because
 *     the asterisk-bloom cycle is longer (12 frames) and reads better
 *     unhurried.
 *   - Platform-conditional `getDefaultCharacters()` mirrors Claude
 *     Code's own Ghostty / non-Ghostty / non-darwin substitutions;
 *     glyph rendering offsets vary by terminal so this matters.
 */

import { Show, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"

/**
 * Default characters per Claude Code's `Spinner/utils.ts:4-11`:
 *
 *   - Ghostty:  `· ✢ ✳ ✶ ✻ *`   (✽ renders mis-aligned in Ghostty)
 *   - darwin:   `· ✢ ✳ ✶ ✻ ✽`
 *   - other:    `· ✢ * ✶ ✻ ✽`   (the second-position asterisk is the
 *                                same `*` substitution)
 */
function getDefaultCharacters(): readonly string[] {
  if (process.env.TERM === "xterm-ghostty") {
    return ["·", "✢", "✳", "✶", "✻", "*"]
  }
  return process.platform === "darwin" ? ["·", "✢", "✳", "✶", "✻", "✽"] : ["·", "✢", "*", "✶", "✻", "✽"]
}

/**
 * Forward then reverse: `dot → bloom → asterisk → deflate → dot`.
 * Source: `refs/claude-code/src/components/Spinner/SpinnerGlyph.tsx:7`
 * (`[...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()]`).
 */
const SPINNER_FRAMES: readonly string[] = (() => {
  const base = getDefaultCharacters()
  return [...base, ...[...base].reverse()]
})()

/** Tick interval. 120ms feels right for the bloom/deflate cycle. */
const FRAME_MS = 120

export interface LoadingProps {
  /**
   * Optional label override. Defaults to "thinking" to match opcode's
   * "Claude is thinking…" copy without the redundant "Claude is" prefix
   * (the chat header already says we're talking to Claude).
   */
  label?: string
  /**
   * Wall-clock timestamp (ms) marking the start of the current turn.
   * When supplied, renders an elapsed timer next to the spinner —
   * mirrors Claude Code's `SpinnerAnimationRow` `(2m 41s · …)`.
   */
  startedAt?: number
  /**
   * Total chars of assistant text streamed in the current turn. Token
   * count is approximated as `chars / 4` (Claude Code's heuristic in
   * `SpinnerAnimationRow.tsx` — `leaderTokens = Math.round(chars / 4)`).
   * Omit (or pass 0) to suppress the token segment.
   */
  responseChars?: number
}

/** ms / chars formatters ported from `refs/claude-code/src/utils/format.ts`. */
function formatDuration(ms: number): string {
  if (ms < 1000) return "0s"
  const totalSec = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  if (minutes === 0) return `${seconds}s`
  const hours = Math.floor(minutes / 60)
  if (hours === 0) return `${minutes}m ${seconds}s`
  return `${hours}h ${minutes % 60}m ${seconds}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k.toFixed(1).replace(/\.0$/, "")}k`
  }
  const m = n / 1_000_000
  return `${m.toFixed(1).replace(/\.0$/, "")}m`
}

/**
 * Animated thinking indicator. Renders as `<spinner> <label> (elapsed · ↓ N tokens)`
 * on a single line in `theme.textMuted` so it doesn't compete with the
 * actual message content. Self-contained — drop it anywhere the
 * chat wants to say "we're working on it."
 */
export function Loading(props: LoadingProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  // Tick the frame index + clock on a fixed interval. Both ride the
  // same setInterval — Claude Code does the same thing in its
  // `SpinnerAnimationRow` (one `useAnimationFrame(50)`).
  const handle = setInterval(() => {
    setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
    setNow(Date.now())
  }, FRAME_MS)

  onCleanup(() => {
    clearInterval(handle)
  })

  const elapsed = () => (props.startedAt !== undefined ? Math.max(0, now() - props.startedAt) : 0)
  const tokens = () => Math.round((props.responseChars ?? 0) / 4)
  const showStats = () => props.startedAt !== undefined
  const stats = () => {
    const parts = [formatDuration(elapsed())]
    const t = tokens()
    if (t > 0) parts.push(`↓ ${formatTokens(t)} tokens`)
    return parts.join(" · ")
  }

  return (
    <box flexDirection="row" gap={1} paddingTop={1}>
      <text fg={theme.accent}>{SPINNER_FRAMES[frame()] ?? SPINNER_FRAMES[0]}</text>
      <text fg={theme.textMuted}>{props.label ?? "thinking"}</text>
      <Show when={showStats()}>
        <text fg={theme.textMuted}>({stats()})</text>
      </Show>
    </box>
  )
}
