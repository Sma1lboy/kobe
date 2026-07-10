/** OSC 0 sets both the terminal's icon/session title and window title. */
export const KOBE_TERMINAL_TITLE_SEQUENCE = "\x1b]0;kobe\x07"

interface TerminalTitleOutput {
  readonly isTTY?: boolean
  write(chunk: string): unknown
}

/** Publish kobe's product name to the outer terminal without polluting pipes. */
export function publishKobeTerminalTitle(output: TerminalTitleOutput = process.stdout): boolean {
  if (!output.isTTY) return false
  output.write(KOBE_TERMINAL_TITLE_SEQUENCE)
  return true
}
