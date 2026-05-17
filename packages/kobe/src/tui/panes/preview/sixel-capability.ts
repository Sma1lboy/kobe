/**
 * Detect whether the host terminal can render sixel escape sequences.
 *
 * We don't query the terminal — that requires a DA1/DA2 exchange on
 * stdout/stdin that races with opentui's own startup handshake. Instead
 * we rely on environment variables every supporting terminal sets:
 *
 *   - `WT_SESSION`              Windows Terminal (≥1.22 supports sixel)
 *   - `KITTY_WINDOW_ID`         kitty
 *   - `TERM_PROGRAM=iTerm.app`  iTerm2 (sixel since 3.5)
 *   - `TERM=xterm*` + `XTERM_VERSION` (xterm with --enable-sixel)
 *   - `TERM=mlterm`             mlterm
 *
 * The user can force-enable or -disable via `KOBE_PREVIEW_SIXEL=1` /
 * `=0` (handy for terminals we haven't catalogued yet, or to confirm
 * the chafa-symbols fallback still works on a sixel-capable host).
 */

export function detectSixelSupport(): boolean {
  const override = process.env.KOBE_PREVIEW_SIXEL
  if (override === "1") return true
  if (override === "0") return false
  if (process.env.WT_SESSION) return true
  if (process.env.KITTY_WINDOW_ID) return true
  if (process.env.TERM_PROGRAM === "iTerm.app") return true
  if (process.env.TERM_PROGRAM === "WezTerm") return true
  const term = process.env.TERM ?? ""
  if (term === "mlterm" || term === "yaft-256color") return true
  if (term.startsWith("xterm") && process.env.XTERM_VERSION) return true
  return false
}
