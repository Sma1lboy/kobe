/** Read-only PTY-host inventory types and OSC title tracking. */

import type { StringDecoder } from "node:string_decoder"

/** One session's inventory row — what `pty.list` reports. */
export interface PtySessionInfo {
  readonly key: string
  readonly alive: boolean
  readonly pid: number | null
  readonly command: readonly string[]
  /** Last OSC 0/2 window title the child set ("" until it sets one). */
  readonly title: string
  /** A local TUI parked this session and retained a serialized xterm screen. */
  readonly parked?: boolean
  /** Byte size of that local parked screen; zero when no parked screen exists. */
  readonly parkedScreenBytes?: number
}

/** Aggregate, read-only terminal retention facts returned with `pty.list`. */
export interface PtyHostStats {
  readonly ringBytes: number
  readonly ringCapacityBytes: number
  readonly parkedSessions: number
  readonly parkedScreenBytes: number
  /** Exact delta wakes since this host started. */
  readonly parkRestoreDeltas: number
  /** Park wakes that had to fall back to a full ring replay. */
  readonly parkRestoreFallbacks: number
}

type PtyTitleState = {
  title: string
  titleCarry: string
  readonly titleDecoder: StringDecoder
}

/** A complete OSC 0/2 window-title sequence (BEL- or ST-terminated). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the raw ESC/BEL title wire encoding is the whole point
const OSC_TITLE_RE = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
/** Titles are short — a longer carry isn't an in-progress title sequence. */
const TITLE_CARRY_CAP = 1024

/** Keep the latest complete OSC title while preserving a split escape tail. */
export function scanOscTitle(session: PtyTitleState, buf: Buffer): void {
  const text = session.titleCarry + session.titleDecoder.write(buf)
  let last: string | null = null
  let end = 0
  OSC_TITLE_RE.lastIndex = 0
  for (let match = OSC_TITLE_RE.exec(text); match; match = OSC_TITLE_RE.exec(text)) {
    last = match[1] ?? ""
    end = match.index + match[0].length
  }
  if (last !== null) session.title = last
  const rest = text.slice(end)
  const escapeIndex = rest.lastIndexOf("\x1b")
  session.titleCarry = escapeIndex === -1 ? "" : rest.slice(escapeIndex, escapeIndex + TITLE_CARRY_CAP)
}
