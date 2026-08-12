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
 *
 * One deviation: claude-code's third frame is `✳` (U+2733), the only glyph in
 * the set with the Unicode Emoji property. Windows font fallback (Segoe UI
 * Emoji) draws it as the green color-emoji asterisk — and ignores a VS15
 * (U+FE0E) text-presentation request — so it clashes with the surrounding
 * monochrome frames. Kobe substitutes `✱` (U+2731 HEAVY ASTERISK), which has
 * no emoji mapping anywhere and keeps the ·→✽ size ramp intact.
 */
const CLAUDE_SPINNER_CHARS: readonly string[] = ["·", "✢", "✱", "✶", "✻", "✽"]
export const CLAUDE_SPINNER_FRAMES: readonly string[] = [
  ...CLAUDE_SPINNER_CHARS,
  ...[...CLAUDE_SPINNER_CHARS].reverse(),
]
