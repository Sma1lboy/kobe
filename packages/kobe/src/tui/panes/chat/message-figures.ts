/**
 * Claude Code's `BLACK_CIRCLE` figure. Source:
 * `refs/claude-code/src/constants/figures.ts:4`. Darwin gets the
 * "media-stop" glyph (visually a filled circle), other platforms get
 * the standard black-circle codepoint, which renders identically.
 */
export const BLACK_CIRCLE = process.platform === "darwin" ? "⏺" : "●"

/**
 * Reference-mark figure used by Claude Code for system rows. Source:
 * `refs/claude-code/src/constants/figures.ts:28`.
 */
export const REFERENCE_MARK = "※"

/**
 * Glyph used by `MessageResponse.tsx` to indent tool-result previews.
 * Source: `refs/claude-code/src/components/MessageResponse.tsx:22`.
 */
export const RESULT_PREFIX = "⎿ "
