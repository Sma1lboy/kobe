/**
 * Live-preview capture for the outer monitor (KOB-230).
 *
 * Thin wrapper over the shared tmux client: resolve the claude pane by
 * its `@kobe_role` tag (`claudePaneId` — robust to `base-index` AND to
 * tmux's by-position pane renumbering once the left Tasks pane is
 * inserted, KOB-233) and capture it. The only monitor-specific piece is
 * `stripAnsi`, which the LivePreview renders as plain text (opentui owns
 * the colours).
 */

import { capturePaneById, claudePaneId } from "@/tmux/client"

/**
 * Capture the current text of a task's claude pane.
 *
 * Returns `null` when there's NO claude pane to capture — the session
 * doesn't exist (a task not yet entered, or one whose session was
 * killed). Returns a string (possibly `""`) when the pane exists: `""`
 * means a live-but-momentarily-blank pane (e.g. a TUI mid-repaint). The
 * caller distinguishes the two so it doesn't show a "press ⏎ to enter"
 * hint over a running session (KOB-244). Never throws — capture failures
 * are non-fatal for the monitor.
 *
 * `lines` (optional) extends the capture into scrollback.
 */
export async function capturePane(sessionName: string, lines?: number): Promise<string | null> {
  const paneId = await claudePaneId(sessionName)
  if (!paneId) return null
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
      // Charset designators (ESC ( B / ESC ) 0 …) — emitted often by
      // Ink/Claude-Code TUIs; not caught by the leftover-escape rule below
      // (their intermediate byte 0x28/0x29 is < 0x40). Strip before it.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: charset designation.
      .replace(/\x1b[()][\x20-\x2f]*[\x30-\x7e]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: leftover escapes.
      .replace(/\x1b[@-Z\\-_]/g, "")
  )
}
