/**
 * Live-preview capture for the outer monitor (KOB-230).
 *
 * Thin wrapper over the shared tmux client: resolve the claude pane
 * by id (`firstPaneId` — immune to `base-index`, KOB-233) and capture
 * it. The only monitor-specific piece is `stripAnsi`, which the
 * LivePreview renders as plain text (opentui owns the colours).
 */

import { capturePaneById, firstPaneId } from "@/tmux/client"

/**
 * Capture the current text of a task's claude pane. Returns the empty
 * string when the session doesn't exist (a task that hasn't been
 * entered yet, or one whose session was killed). Never throws —
 * capture failures are non-fatal for the monitor.
 *
 * `lines` (optional) extends the capture into scrollback.
 */
export async function capturePane(sessionName: string, lines?: number): Promise<string> {
  const paneId = await firstPaneId(sessionName)
  if (!paneId) return ""
  return capturePaneById(paneId, lines)
}

/**
 * Strip ANSI SGR / cursor escape sequences from `text` so it can be
 * rendered as plain text in opentui. We deliberately don't preserve
 * colour: the preview is meant to be a quick "what's claude doing"
 * summary, not a full mirror — opentui's renderer has its own theme
 * and colour-passing tmux output would clash.
 */
export function stripAnsi(text: string): string {
  // CSI sequences (most ANSI escapes): `\x1b[` + parameter bytes + final byte.
  // Plus OSC (`\x1b]...\x07` or `\x1b]...\x1b\\`).
  // Plus a few common single-char escapes (CR alone is fine; we keep \n).
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI parsing.
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: OSC.
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: leftover escapes.
      .replace(/\x1b[@-Z\\-_]/g, "")
  )
}
