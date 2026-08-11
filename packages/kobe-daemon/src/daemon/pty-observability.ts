/** Read-only PTY-host inventory types, ring peeks, and OSC title tracking. */

import type { StringDecoder } from "node:string_decoder"
import type { PtyPeekResult, PtySessionExit } from "./protocol.ts"
import type { PtyExit } from "./pty-driver.ts"

/** One session's inventory row — what `pty.list` reports. */
export interface PtySessionInfo {
  readonly key: string
  readonly alive: boolean
  readonly pid: number | null
  readonly command: readonly string[]
  /** Last OSC 0/2 window title the child set ("" until it sets one). */
  readonly title: string
  /** Total bytes the child has EVER written (monotonic, never reduced by
   *  ring trimming) — the daemon activity observer's output heartbeat. */
  readonly totalBytes?: number
  /** A local TUI parked this session and retained a serialized xterm screen. */
  readonly parked?: boolean
  /** Byte size of that local parked screen; zero when no parked screen exists. */
  readonly parkedScreenBytes?: number
  /** How the child died — null while alive or before exit was observed. */
  readonly exit?: PtySessionExit | null
}

/** What the host hands `onSessionExit` — the death record for one session. */
export interface PtySessionEndInfo {
  readonly key: string
  readonly pid: number | null
  readonly exit: PtySessionExit
  /** Raw tail of the ring at exit time (ANSI included; consumers strip). */
  readonly tail: string
}

/** Human suffix for the host's `session <key> exited` log line. */
export function describeExit(exit: PtyExit | undefined): string {
  if (exit?.signal) return ` (signal ${exit.signal})`
  if (exit && exit.code !== null) return ` (code ${exit.code})`
  return " (cause unknown)"
}

/** Last `maxBytes` of the ring as lossy UTF-8 — the child's final output. */
export function ringTail(chunks: readonly Buffer[], bytes: number, maxBytes: number): string {
  const skip = Math.max(0, bytes - maxBytes)
  let seen = 0
  const parts: Buffer[] = []
  for (const chunk of chunks) {
    if (seen + chunk.byteLength > skip) parts.push(seen >= skip ? chunk : chunk.subarray(skip - seen))
    seen += chunk.byteLength
  }
  return Buffer.concat(parts).toString("utf8")
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

/**
 * What to carry into the next chunk from `rest` (the tail past the last
 * complete title). Only a trailing INCOMPLETE OSC-title sequence matters,
 * and it begins at the last OSC introducer `\x1b]` — a buffer ending in a
 * bare ESC may be that introducer's first byte. Anchoring on any *later*
 * bare ESC (the pre-fix `lastIndexOf("\x1b")`) strands the real title: a
 * split ST terminator (`…title\x1b` | `\`) or a color escape after an
 * in-progress title both leave a later ESC that is NOT the introducer, so
 * the whole `\x1b]0;title` prefix — and the tab name it drives — was lost
 * (regression of b8737857, reintroduced by the #334 module extraction).
 */
function titleCarryFrom(rest: string): string {
  const osc = rest.lastIndexOf("\x1b]")
  if (osc !== -1) return rest.slice(osc, osc + TITLE_CARRY_CAP)
  return rest.endsWith("\x1b") ? "\x1b" : ""
}

/**
 * Fold one already-decoded chunk (prepended with the previous chunk's
 * carry) into the last complete OSC 0/2 title it contains, plus the tail to
 * carry forward. Pure — exported for the cross-chunk boundary tests, which
 * a real PTY can't drive (read boundaries fall anywhere, including inside a
 * title's terminator). `title: null` = the chunk closed no title.
 */
export function foldOscTitle(prevCarry: string, chunkText: string): { title: string | null; carry: string } {
  const text = prevCarry + chunkText
  let title: string | null = null
  let end = 0
  OSC_TITLE_RE.lastIndex = 0
  for (let match = OSC_TITLE_RE.exec(text); match; match = OSC_TITLE_RE.exec(text)) {
    title = match[1] ?? ""
    end = match.index + match[0].length
  }
  return { title, carry: titleCarryFrom(text.slice(end)) }
}

/** Keep the latest complete OSC title while preserving a split escape tail. */
export function scanOscTitle(session: PtyTitleState, buf: Buffer): void {
  const { title, carry } = foldOscTitle(session.titleCarry, session.titleDecoder.write(buf))
  if (title !== null) session.title = title
  session.titleCarry = carry
}

/** The ring-buffer fields `peekRing` reads off a host session (structural
 *  subset of the host's PtySessionState — pure, so it stays testable). */
export interface PtyRingView {
  readonly alive: boolean
  readonly chunks: readonly Buffer[]
  /** Bytes currently held in the ring (after trimming). */
  readonly bytes: number
  /** Total bytes the child has ever written (monotonic). */
  readonly totalBytes: number
  readonly proc: { readonly pid: number } | null
  /** Recorded death cause, when the child already exited. */
  readonly exit?: PtySessionExit | null
}

/**
 * Read-only ring peek — the pure half of `pty.peek`. Returns the full ring
 * (or the exact delta since `sinceOffset` when it is still inside the ring
 * window) without attaching, spawning, or resizing anything.
 */
export function peekRing(session: PtyRingView | undefined, sinceOffset?: number): PtyPeekResult {
  if (!session) {
    return { exists: false, alive: false, pid: null, offset: 0, data: "", sinceValid: false, exit: null }
  }
  const windowStart = session.totalBytes - session.bytes
  let buf = Buffer.concat(session.chunks as Buffer[])
  let sinceValid = false
  if (sinceOffset !== undefined && sinceOffset >= windowStart && sinceOffset <= session.totalBytes) {
    buf = buf.subarray(sinceOffset - windowStart)
    sinceValid = true
  }
  return {
    exists: true,
    alive: session.alive,
    pid: session.proc?.pid ?? null,
    offset: session.totalBytes,
    data: buf.toString("base64"),
    sinceValid,
    exit: session.exit ?? null,
  }
}
