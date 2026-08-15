/**
 * Pure paging/shaping half of `kobe api read-output` (split for the 500-line
 * cap): the envelope + cursor types, the deterministic page builders, and
 * the terminal-text shaping. No daemon, no PTY host, no vendor imports —
 * the read logic and the verb live in `read-output.ts`, which re-exports
 * this module so `@/cli/api/read-output` stays the one import site.
 */

import type { PtySessionExit } from "@sma1lboy/kobe-daemon/daemon/protocol"
import type { Message } from "../../types/engine.ts"
import { ApiError } from "./types.ts"

// ── Bounds (deterministic paging) ────────────────────────────────────────────

export const DEFAULT_PAGE_MESSAGES = 40
export const MAX_PAGE_MESSAGES = 50
/** Serialized-bytes budget per history page (always at least one message). */
export const PAGE_BYTE_BUDGET = 128 * 1024
/** Any single string inside a message is clipped past this many chars. */
export const STRING_CLIP_CHARS = 16 * 1024
/** Terminal fallback tail caps — lines and bytes. */
export const TERMINAL_TAIL_LINES = 200
export const TERMINAL_TAIL_BYTES = 64 * 1024

// ── Envelope + cursor types ──────────────────────────────────────────────────

export type ReadSource = "history" | "terminal"
export type ReadSourceArg = "auto" | ReadSource
export type FallbackReason = "engine_unsupported" | "history_missing" | "history_unreadable"

export interface ReadOutputEnvelope {
  readonly taskId: string
  readonly source: ReadSource
  readonly history?: {
    /** Vendor session id (flat token, never a path). */
    readonly sessionId: string
    readonly messages: readonly unknown[]
    readonly returnedMessageCount: number
    readonly totalMessages: number
    /** True when the byte budget cut the page short of `limit`. */
    readonly limited: boolean
  }
  readonly terminal?: {
    readonly tail: readonly string[]
    /** True when older output was dropped to fit the tail caps. */
    readonly truncated: boolean
    readonly live: boolean
    /** How the session died when `live` is false — null while alive or
     *  when the host predates exit records. */
    readonly exit?: PtySessionExit | null
    /** The exact tab read (`--tab`); absent for the canonical engine tab. */
    readonly tab?: string
  }
  /** Opaque next-page cursor; null when there is nothing to page. */
  readonly cursor: string | null
  /** Why structured history was NOT used (auto only; null on an explicit source). */
  readonly fallbackReason: FallbackReason | null
  readonly warnings: readonly string[]
}

type HistoryCursor = { v: 1; task: string; src: "history"; sid: string; idx: number }
type TerminalCursor = {
  v: 1
  task: string
  src: "terminal"
  pid: number | null
  off: number
  fr: FallbackReason | null
  /** The tab a `--tab` read is pinned to; absent for canonical-tab reads. */
  tab?: string
}
export type Cursor = HistoryCursor | TerminalCursor
export type { HistoryCursor, TerminalCursor }

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeCursor(raw: string, taskId: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    throw new ApiError("invalid cursor (not a read-output cursor)", "CURSOR_INVALID")
  }
  const c = parsed as Partial<Cursor>
  const shapeOk =
    c !== null &&
    typeof c === "object" &&
    c.v === 1 &&
    typeof c.task === "string" &&
    ((c.src === "history" &&
      typeof (c as HistoryCursor).sid === "string" &&
      typeof (c as HistoryCursor).idx === "number") ||
      (c.src === "terminal" &&
        typeof (c as TerminalCursor).off === "number" &&
        ((c as TerminalCursor).tab === undefined || typeof (c as TerminalCursor).tab === "string")))
  if (!shapeOk) throw new ApiError("invalid cursor (unknown version or shape)", "CURSOR_INVALID")
  if (c.task !== taskId) {
    throw new ApiError(`cursor belongs to task ${c.task}, not ${taskId}`, "CURSOR_TASK_MISMATCH")
  }
  return c as Cursor
}

// ── Bounded page building (pure) ─────────────────────────────────────────────

/** Deep-copy `value` with every long string clipped (bounded pages even
 *  when a single tool result is huge). Messages are plain parsed JSON. */
export function clipStrings(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= STRING_CLIP_CHARS) return value
    return `${value.slice(0, STRING_CLIP_CHARS)}…[+${value.length - STRING_CLIP_CHARS} chars clipped]`
  }
  if (Array.isArray(value)) return value.map(clipStrings)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v)
    return out
  }
  return value
}

export interface HistoryPage {
  readonly page: readonly unknown[]
  readonly nextIdx: number
  readonly limited: boolean
}

/** Deterministic page: up to `limit` messages from `startIdx`, stopping
 *  early (but never before one message) when the byte budget is spent. */
export function buildHistoryPage(messages: readonly Message[], startIdx: number, limit: number): HistoryPage {
  const page: unknown[] = []
  let bytes = 0
  let limited = false
  let i = startIdx
  for (; i < messages.length && page.length < limit; i++) {
    const clipped = clipStrings(messages[i])
    const size = JSON.stringify(clipped).length
    if (page.length > 0 && bytes + size > PAGE_BYTE_BUDGET) {
      limited = true
      break
    }
    page.push(clipped)
    bytes += size
  }
  return { page, nextIdx: i, limited }
}

// ── Terminal text shaping (pure) ─────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping raw ANSI escapes is the point
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]/g

/** Raw PTY bytes → readable lines: strip ANSI, honor CR overwrites. */
export function terminalLines(text: string): string[] {
  const plain = text.replace(ANSI_RE, "").replace(/\r\n/g, "\n")
  return plain.split("\n").map((line) => line.split("\r").pop() ?? "")
}

export interface TerminalTail {
  readonly tail: readonly string[]
  readonly truncated: boolean
}

/** Bounded tail: at most {@link TERMINAL_TAIL_LINES} lines / {@link TERMINAL_TAIL_BYTES} bytes. */
export function boundedTail(text: string): TerminalTail {
  const lines = terminalLines(text)
  let start = Math.max(0, lines.length - TERMINAL_TAIL_LINES)
  let bytes = 0
  for (let i = lines.length - 1; i >= start; i--) {
    bytes += (lines[i]?.length ?? 0) + 1
    if (bytes > TERMINAL_TAIL_BYTES) {
      start = i + 1
      break
    }
  }
  return { tail: lines.slice(start), truncated: start > 0 }
}

// ── Terminal peek page (the dep read-output injects) ─────────────────────────

export interface TerminalPeekPage {
  readonly pid: number | null
  readonly offset: number
  readonly text: string
  /** False when `sinceOffset` was trimmed out of the ring (gap in output). */
  readonly sinceValid: boolean
  readonly live: boolean
  readonly exit?: PtySessionExit | null
}
