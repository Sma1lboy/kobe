/**
 * Terminal diagnostics for `kobe doctor` — issue-triage context for
 * keyboard-protocol-class bugs (issue #192). Keyboard behavior differs by
 * terminal: without the kitty keyboard protocol, ctrl+h / ctrl+j arrive as
 * ambiguous C0 bytes (0x08 backspace / 0x0a linefeed), so knowing WHICH
 * terminal a reporter runs and whether it answers the kitty query tells us
 * which key path they're on without a screen recording. Read-only, like the
 * rest of doctor.
 */

/** `TERM=… TERM_PROGRAM=… COLORTERM=…` plus tmux nesting, from an injected
 *  env so tests don't depend on the runner's terminal. */
export function terminalEnvLines(env: Record<string, string | undefined>): string[] {
  const show = (v: string | undefined): string => (v && v.length > 0 ? v : "(unset)")
  const program = env.TERM_PROGRAM
    ? `${env.TERM_PROGRAM}${env.TERM_PROGRAM_VERSION ? ` v${env.TERM_PROGRAM_VERSION}` : ""}`
    : "(unset)"
  const lines = [
    `terminal: TERM=${show(env.TERM)}  TERM_PROGRAM=${program}  COLORTERM=${show(env.COLORTERM)}`,
    `          running inside tmux: ${env.TMUX ? "yes" : "no"}`,
  ]
  return lines
}

export type KittyProbeResult =
  | { kind: "supported"; flags: number }
  | { kind: "unsupported" }
  | { kind: "no-response" }
  | { kind: "skipped"; reason: string }

/**
 * Decide from accumulated reply bytes. The probe writes `CSI ? u` (kitty
 * flags query) followed by `CSI c` (DA1) as a fence: every terminal answers
 * DA1, so a DA1 reply WITHOUT a preceding `CSI ? <flags> u` means the kitty
 * query was ignored — protocol unsupported. Returns null while undecided
 * (keep reading until timeout).
 */
export function parseKittyProbeReply(data: string): KittyProbeResult | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching a raw ESC-prefixed terminal reply is the whole point
  const kitty = data.match(/\x1b\[\?(\d+)u/)
  if (kitty?.[1] !== undefined) return { kind: "supported", flags: Number.parseInt(kitty[1], 10) }
  // DA1 reply: CSI ? <params> c
  // biome-ignore lint/suspicious/noControlCharactersInRegex: same — raw DA1 escape reply
  if (/\x1b\[\?[\d;]*c/.test(data)) return { kind: "unsupported" }
  return null
}

/** One doctor line per probe outcome, with the triage hint inline. */
export function kittyProbeLine(result: KittyProbeResult): string {
  switch (result.kind) {
    case "supported":
      return `          kitty keyboard protocol: ✓ answered (flags=${result.flags})`
    case "unsupported":
      return "          kitty keyboard protocol: ✗ not supported — legacy key path (ctrl+h/ctrl+j arrive as C0 backspace/linefeed bytes)"
    case "no-response":
      return "          kitty keyboard protocol: ? no reply (terminal ignored both the kitty query and DA1)"
    case "skipped":
      return `          kitty keyboard protocol: skipped (${result.reason})`
  }
}

/**
 * Live probe against the controlling terminal. Only runs when stdin AND
 * stdout are TTYs (piped `kobe doctor | pbcopy` must not emit escape bytes
 * into the pipe or wait on a reply that can't come). Raw mode for the read,
 * always restored; hard timeout so doctor can never hang on a mute terminal.
 */
export async function probeKittyKeyboard(timeoutMs = 300): Promise<KittyProbeResult> {
  const stdin = process.stdin
  if (!stdin.isTTY || !process.stdout.isTTY) return { kind: "skipped", reason: "not an interactive terminal" }

  const wasRaw = stdin.isRaw === true
  let buffer = ""
  return await new Promise<KittyProbeResult>((resolve) => {
    let done = false
    const finish = (result: KittyProbeResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stdin.off("data", onData)
      stdin.pause()
      if (!wasRaw) stdin.setRawMode(false)
      resolve(result)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("latin1")
      const decided = parseKittyProbeReply(buffer)
      if (decided) finish(decided)
    }
    const timer = setTimeout(() => finish({ kind: "no-response" }), timeoutMs)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
    process.stdout.write("\x1b[?u\x1b[c")
  })
}

/** The whole `terminal:` doctor section (env lines + live kitty probe). */
export async function terminalDoctorLines(): Promise<string[]> {
  return [...terminalEnvLines(process.env), kittyProbeLine(await probeKittyKeyboard())]
}
