/**
 * The ONE spinner frame set for running rows.
 *
 * Per-engine brand frames were a registry field (`spinnerFrames`) with
 * exactly one implementation: Claude Code's `·→✢→✱→✶→✻→✽` oscillation,
 * lifted from refs/claude-code. Both were removed 2026-08-15 — on a font
 * without the dingbat block (FiraCode Nerd Font, one of the owner's daily
 * faces) macOS falls each frame back to ZapfDingbats at a DIFFERENT advance
 * per glyph (1.11 / 1.13 / 1.15 / 1.21 / 1.28 cells), so a running row
 * jittered at 10Hz. Braille falls back as ONE face (AppleBraille, 1.11
 * cells for every frame): uniform even when it isn't the base font, which
 * is the property a frame set actually needs.
 *
 * Re-introducing a brand set means re-introducing that field. Measure the
 * candidate's per-frame advance in the fonts people run first — equal
 * advance across frames is the bar, not "the vendor uses it".
 *
 * Must stay importable from vitest and MUST NOT import from `src/tui/`.
 */

/** The braille dots every engine animates with. */
export const DEFAULT_SPINNER_FRAMES: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
