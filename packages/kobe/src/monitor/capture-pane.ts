/**
 * Wrapper around `tmux capture-pane` for the outer monitor's live
 * preview rail (KOB-230).
 *
 * `tmux -L kobe capture-pane -t =<session>:0.0 -p -e` returns the
 * current contents of the claude pane (pane 0). `-e` keeps ANSI escape
 * sequences so the preview keeps colours; `-p` writes to stdout
 * instead of a buffer.
 *
 * Stays out of `tui/panes/terminal/tmux.ts` because:
 *   - `tmux.ts` owns the session lifecycle (create / split / kill),
 *     which is write-side; capture-pane is read-side.
 *   - The monitor renders the captured text raw (or strips ANSI for
 *     a plain summary), and the renderer lives next to the monitor
 *     pane, not the launcher.
 */

const SOCKET = "kobe"

/**
 * Capture the current text of `pane` from kobe's tmux server. Defaults
 * to pane 0 of window 0 — the claude pane in the v0.6 three-pane layout.
 *
 * Returns the empty string when the session doesn't exist (a task that
 * hasn't been entered yet, or one whose session was killed). Never
 * throws — capture failures are non-fatal for the monitor.
 *
 * `lines` (optional) limits the captured slice from the bottom of the
 * pane history; default returns the visible viewport only (no history).
 */
export async function capturePane(sessionName: string, lines?: number): Promise<string> {
  const target = `=${sessionName}:0.0`
  const args = ["tmux", "-L", SOCKET, "capture-pane", "-t", target, "-p"]
  if (typeof lines === "number" && lines > 0) {
    // Start `-lines` rows back from the visible bottom. tmux uses
    // negative line numbers for scrollback positions.
    args.push("-S", String(-lines))
  }
  try {
    const proc = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return ""
    return text
  } catch {
    return ""
  }
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
