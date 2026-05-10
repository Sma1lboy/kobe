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
 * Two flourishes copied from `claude-code` so kobe's loader matches the
 * official CLI feel:
 *
 *   1. **Random verb** — instead of always "thinking", we pick a verb
 *      from `spinnerVerbs.ts` (Pondering / Caramelizing / Beboppin' …)
 *      once at component mount. Source: claude-code
 *      `constants/spinnerVerbs.ts:16-204`.
 *   2. **Glimmer wave** — a 3-character bright "spotlight" sweeps
 *      left-to-right through the verb, with the chars at `glimmerIndex`
 *      ± 1 rendered in `theme.text`, the rest in `theme.textMuted`.
 *      Source: claude-code `Spinner/GlimmerMessage.tsx:211-326`
 *      and `Spinner/useShimmerAnimation.ts`. We drive the glimmer off
 *      the same 120ms tick as the glyph instead of running a second
 *      clock — claude-code uses 50ms for smoother shimmer but kobe is
 *      single-pane and doesn't need that precision.
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

import { Show, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { pickRandomVerb } from "./spinnerVerbs"

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

/**
 * Trailing/leading "pad" columns the glimmer sweeps across past the
 * label edges before wrapping. Mirrors claude-code's `messageWidth + 20`
 * cycle (`Spinner/useShimmerAnimation.ts:25`) — gives a visible pause
 * between sweeps so the wave reads as a rhythmic pulse, not a churn.
 */
const GLIMMER_PAD = 10

export interface LoadingProps {
  /**
   * Optional label override. When omitted, a random verb is picked at
   * mount from `spinnerVerbs.ts` ("Pondering", "Caramelizing", …) so
   * the loader matches Claude Code's playful per-turn copy. Pass a
   * fixed label here when callers want a deterministic word
   * (e.g. tests, or a non-streaming wait state).
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
 * Animated thinking indicator. Renders as `<spinner> <verb>… (elapsed · ↓ N tokens)`
 * on a single line; the verb has a 3-character bright spotlight that
 * sweeps left-to-right through the word every ~3s. Self-contained —
 * drop it anywhere the chat wants to say "we're working on it."
 */
export function Loading(props: LoadingProps) {
  const { theme } = useTheme()
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  // Verb is picked once per mount. `Loading` mounts when streaming
  // begins and unmounts when it ends, so this gives a fresh verb per
  // turn — matching claude-code's per-turn `getSpinnerVerbs()` pull
  // without dragging in their session-scoped key state.
  //
  // `KOBE_SPINNER_VERB` env override exists for behavior tests: the
  // PTY harness needs a deterministic substring to wait on, and a
  // 200-entry random pool defeats `screen.includes(...)` assertions.
  // Production never sets it.
  const verb = props.label ?? process.env.KOBE_SPINNER_VERB ?? pickRandomVerb()
  // Single-cell-per-char approximation. Good enough for the verb pool —
  // entries are ASCII / latin-1 (`Sautéing`, `Flambéing`, `Whatchamacalliting`)
  // and there are no double-width glyphs. If we ever ship CJK verbs,
  // swap to `stringWidth` here and in the slicing below.
  const verbWidth = verb.length

  // Tick the frame index + clock on a fixed interval. Both ride the
  // same setInterval — Claude Code does the same thing in its
  // `SpinnerAnimationRow` (one `useAnimationFrame(50)`).
  const handle = setInterval(() => {
    setFrame((f) => f + 1)
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

  // Glimmer index walks left-to-right across the verb, repeating with
  // a pause at each end. cycle = verbWidth + 2*PAD; offset by -PAD so
  // it begins offscreen-left, sweeps across, ends offscreen-right.
  const glimmerIndex = createMemo(() => {
    const cycle = verbWidth + GLIMMER_PAD * 2
    return (frame() % cycle) - GLIMMER_PAD
  })

  // Split the verb into [before | shim | after] segments based on the
  // glimmer window (glimmerIndex ± 1). Mirrors GlimmerMessage.tsx:211-279.
  // When the window is fully off-screen, before == verb and shim/after
  // are empty, so the verb renders flat-muted.
  const segments = createMemo(() => {
    const idx = glimmerIndex()
    const start = idx - 1
    const end = idx + 1
    if (start >= verbWidth || end < 0) {
      return { before: verb, shim: "", after: "" }
    }
    const cs = Math.max(0, start)
    const ce = Math.min(verbWidth - 1, end)
    return {
      before: verb.slice(0, cs),
      shim: verb.slice(cs, ce + 1),
      after: verb.slice(ce + 1),
    }
  })

  const glyph = () => SPINNER_FRAMES[frame() % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]

  return (
    <box flexDirection="row" paddingTop={1}>
      {/* Fixed 2-cell column for the spinner — glyphs `· ✢ ✳ ✶ ✻ ✽` have
          ambiguous east-asian widths and would otherwise nudge the label
          left/right each frame. Mirrors claude-code `SpinnerGlyph.tsx:40`
          (`<Box flexWrap="wrap" height={1} width={2}>`). The 2nd cell
          doubles as the separator before the label, so no parent gap. */}
      <box width={2} height={1}>
        <text fg={theme.accent}>{glyph()}</text>
      </box>
      <text>
        <Show when={segments().before}>
          <span style={{ fg: theme.textMuted }}>{segments().before}</span>
        </Show>
        <Show when={segments().shim}>
          <span style={{ fg: theme.text }}>{segments().shim}</span>
        </Show>
        <Show when={segments().after}>
          <span style={{ fg: theme.textMuted }}>{segments().after}</span>
        </Show>
        <span style={{ fg: theme.textMuted }}>…</span>
      </text>
      <Show when={showStats()}>
        <text fg={theme.textMuted}> ({stats()})</text>
      </Show>
    </box>
  )
}
