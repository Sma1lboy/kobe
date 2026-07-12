/**
 * System-clipboard delivery for the embedded terminal's copy-on-select —
 * OSC52 alone is not enough:
 * several terminals ship with it disabled (iTerm2) or unsupported
 * (Terminal.app), so the selection is ALSO piped into the platform
 * clipboard command when one exists (pbcopy / wl-copy / xclip / xsel).
 * Both channels fire — the local pipe covers strict terminals, OSC52
 * covers SSH/remote sessions where the local pipe lands on the wrong
 * machine's clipboard.
 */

import { clipboardBinaryOnPath, resolveClipboardCopyCommand } from "../../lib/clipboard-command"

/** Resolved once per process — the probe shells out to `which`. */
let resolvedCommand: string | null | undefined

function clipboardCommand(): string | null {
  if (resolvedCommand === undefined) {
    resolvedCommand = resolveClipboardCopyCommand(process.platform, clipboardBinaryOnPath)
  }
  return resolvedCommand
}

/**
 * Best-effort copy: local clipboard command (when available) + the
 * caller-supplied OSC52 writer. Never throws.
 */
export function copyTextToSystemClipboard(text: string, osc52: (text: string) => void): void {
  const cmd = clipboardCommand()
  if (cmd) {
    try {
      const proc = Bun.spawn(["sh", "-c", cmd], { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
      proc.stdin.write(text)
      void proc.stdin.end()
    } catch {
      /* fall through to OSC52 */
    }
  }
  try {
    osc52(text)
  } catch {
    /* best-effort */
  }
}
