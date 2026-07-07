/**
 * Engine-owned spinner frame sets (CLAUDE.md "Engine-owned UI data").
 *
 * The sidebar's running-row badge animates with the task engine's own
 * brand spinner instead of one hard-coded set: the registry entry carries
 * `spinnerFrames`, and neutral layers fall back to
 * {@link DEFAULT_SPINNER_FRAMES} when an engine doesn't declare one.
 *
 * Must stay importable from vitest and MUST NOT import from `src/tui/`
 * (same constraint as the registry that consumes it).
 */

/** Neutral fallback — the braille dots every engine without a brand set gets. */
export const DEFAULT_SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/**
 * Claude Code's brand spinner, lifted from refs/claude-code
 * `src/components/Spinner.tsx` (`getDefaultCharacters()` + the
 * forward-then-reverse concat that makes the glyph oscillate ·→✽→· with a
 * one-frame hold at each end).
 */
const CLAUDE_SPINNER_CHARS: readonly string[] = ["·", "✢", "✳", "✶", "✻", "✽"]
export const CLAUDE_SPINNER_FRAMES: readonly string[] = [
  ...CLAUDE_SPINNER_CHARS,
  ...[...CLAUDE_SPINNER_CHARS].reverse(),
]

/**
 * Reduced-motion replacement for EVERY engine's frame set: a dot that
 * pulses big/small on a 2s cycle (Claude Code's `REDUCED_MOTION_DOT` +
 * `REDUCED_MOTION_CYCLE_MS` counterpart). Encoded as 10 frames per phase
 * so the shared 10Hz tick drives it without a second timer; identical
 * consecutive frames re-render nothing (`withSpinnerFrame` returns the
 * same view when the glyph is unchanged).
 */
export const REDUCED_MOTION_SPINNER_FRAMES: readonly string[] = [...Array(10).fill("●"), ...Array(10).fill("·")]
