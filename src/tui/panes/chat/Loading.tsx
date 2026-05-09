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

import { createSignal, onCleanup } from "solid-js"
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
