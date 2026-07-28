/**
 * `kobe api read-output` — structured, cursor-paged read of a task's
 * engine session output, so a coordinator agent can see what a task's
 * engine did WITHOUT scraping its terminal.
 *
 * Source selection (mirrors orca's structured worker-read, adapted to
 * kobe's simpler topology where a Task already binds worktree + engine
 * session):
 *
 *   auto      → the engine adapter's own transcript history when it
 *               exists, else a bounded terminal tail labeled with a typed
 *               `fallbackReason`.
 *   history   → require structured history; typed error instead of
 *               falling back.
 *   terminal  → the bounded terminal tail (never probes history).
 *
 * Contract rules:
 *   - The envelope ALWAYS says which source was used.
 *   - Pages are bounded: message count, serialized byte budget, and
 *     per-string clipping. Pagination is deterministic.
 *   - The opaque cursor stays pinned to ONE source + session/incarnation;
 *     when that changed underneath, the read returns a typed
 *     SOURCE_CHANGED error instead of silently switching.
 *   - No absolute transcript paths in the envelope or the cursor
 *     (session ids are flat vendor tokens, terminal identity is a pid).
 *   - Strictly read-only: never spawns, attaches, resizes, or mutates
 *     task/engine lifecycle (terminal reads go through `pty.peek`).
 */

import type { PtyPeekResult, SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { type EngineHistoryReader, engineEntry, supportsStructuredHistory } from "../../engine/registry.ts"
import type { Message } from "../../types/engine.ts"
import type { VendorId } from "../../types/vendor.ts"
import { daemonOf } from "./handler-helpers.ts"
import { findEngineKey, listSessions, openPtyHost } from "./pty-delivery.ts"
import { resolveActiveTaskId } from "./runtime.ts"
import { ApiError, type VerbContext, type VerbSpec } from "./types.ts"

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
}
type Cursor = HistoryCursor | TerminalCursor

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
      (c.src === "terminal" && typeof (c as TerminalCursor).off === "number"))
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

// ── The read itself (deps-injected, unit-testable) ───────────────────────────

export interface TerminalPeekPage {
  readonly pid: number | null
  readonly offset: number
  readonly text: string
  /** False when `sinceOffset` was trimmed out of the ring (gap in output). */
  readonly sinceValid: boolean
  readonly live: boolean
}

export interface ReadOutputDeps {
  /** The engine adapter's transcript reader; null = engine ships none. */
  readonly history: EngineHistoryReader | null
  /** Bounded ring peek of the task's live engine pane; null = no host / no session. */
  peekTerminal(sinceOffset?: number): Promise<TerminalPeekPage | null>
}

export interface ReadOutputInput {
  readonly taskId: string
  /** Task worktree (null when not materialized — history is then missing). */
  readonly worktree: string | null
  readonly source: ReadSourceArg
  readonly cursor?: string
  readonly limit?: number
}

function sourceChanged(detail: string): ApiError {
  return new ApiError(`${detail} — restart the read without the cursor`, "SOURCE_CHANGED")
}

export async function readTaskOutput(input: ReadOutputInput, deps: ReadOutputDeps): Promise<ReadOutputEnvelope> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_MESSAGES, 1), MAX_PAGE_MESSAGES)

  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, input.taskId)
    if (input.source !== "auto" && input.source !== cursor.src) {
      throw new ApiError(
        `cursor is pinned to source "${cursor.src}" but --source is "${input.source}"`,
        "CURSOR_INVALID",
      )
    }
    return cursor.src === "history"
      ? continueHistory(input, deps, cursor, limit)
      : continueTerminal(input, deps, cursor)
  }

  if (input.source === "terminal") return firstTerminalPage(input, deps, null)

  const first = await tryFirstHistoryPage(input, deps, limit)
  if (typeof first !== "string") return first
  if (input.source === "history") {
    throw new ApiError(`structured history unavailable for ${input.taskId}: ${first}`, "HISTORY_REQUIRED")
  }
  return firstTerminalPage(input, deps, first)
}

/** The task's CURRENT engine conversation = the newest session recorded
 *  for its worktree (a kobe worktree is task-exclusive, so every session
 *  there belongs to this task — no directory-guessing across tasks). */
async function currentSessionId(history: EngineHistoryReader, worktree: string): Promise<string | null> {
  const ids = await history.listSessionIdsForWorktree(worktree)
  return ids.length > 0 ? (ids[ids.length - 1] ?? null) : null
}

async function tryFirstHistoryPage(
  input: ReadOutputInput,
  deps: ReadOutputDeps,
  limit: number,
): Promise<ReadOutputEnvelope | FallbackReason> {
  if (!deps.history) return "engine_unsupported"
  if (!input.worktree) return "history_missing"
  let sid: string | null
  try {
    sid = await currentSessionId(deps.history, input.worktree)
  } catch {
    return "history_unreadable"
  }
  if (!sid) return "history_missing"
  let messages: readonly Message[]
  try {
    messages = await deps.history.readHistory(sid)
  } catch {
    return "history_unreadable"
  }
  return historyEnvelope(input.taskId, sid, messages, 0, limit)
}

async function continueHistory(
  input: ReadOutputInput,
  deps: ReadOutputDeps,
  cursor: HistoryCursor,
  limit: number,
): Promise<ReadOutputEnvelope> {
  if (!deps.history || !input.worktree) throw sourceChanged("the engine no longer provides structured history")
  let sid: string | null
  let messages: readonly Message[]
  try {
    sid = await currentSessionId(deps.history, input.worktree)
    messages = sid === cursor.sid ? await deps.history.readHistory(cursor.sid) : []
  } catch {
    throw new ApiError("history became unreadable — retry, or restart without the cursor", "HISTORY_UNREADABLE")
  }
  // The engine started a NEW session (resume/compaction/replacement): never
  // silently merge or switch — the caller restarts without the cursor.
  if (sid !== cursor.sid)
    throw sourceChanged(`the task's engine session changed (was ${cursor.sid}, now ${sid ?? "none"})`)
  // Transcripts are append-only; a shrink means the pinned session was rewritten.
  if (cursor.idx > messages.length) throw sourceChanged("the pinned transcript shrank")
  return historyEnvelope(input.taskId, cursor.sid, messages, cursor.idx, limit)
}

function historyEnvelope(
  taskId: string,
  sessionId: string,
  messages: readonly Message[],
  startIdx: number,
  limit: number,
): ReadOutputEnvelope {
  const { page, nextIdx, limited } = buildHistoryPage(messages, startIdx, limit)
  return {
    taskId,
    source: "history",
    history: {
      sessionId,
      messages: page,
      returnedMessageCount: page.length,
      totalMessages: messages.length,
      limited,
    },
    // Always return a cursor: the session may still be appending, so "no
    // more messages right now" is a poll point, not an end.
    cursor: encodeCursor({ v: 1, task: taskId, src: "history", sid: sessionId, idx: nextIdx }),
    fallbackReason: null,
    warnings: [],
  }
}

async function firstTerminalPage(
  input: ReadOutputInput,
  deps: ReadOutputDeps,
  fallbackReason: FallbackReason | null,
): Promise<ReadOutputEnvelope> {
  const t = await deps.peekTerminal()
  if (!t) {
    return {
      taskId: input.taskId,
      source: "terminal",
      terminal: { tail: [], truncated: false, live: false },
      cursor: null,
      fallbackReason,
      warnings: ["no live terminal session for this task"],
    }
  }
  const { tail, truncated } = boundedTail(t.text)
  return {
    taskId: input.taskId,
    source: "terminal",
    terminal: { tail, truncated, live: t.live },
    cursor: encodeCursor({ v: 1, task: input.taskId, src: "terminal", pid: t.pid, off: t.offset, fr: fallbackReason }),
    fallbackReason,
    warnings: [],
  }
}

async function continueTerminal(
  input: ReadOutputInput,
  deps: ReadOutputDeps,
  cursor: TerminalCursor,
): Promise<ReadOutputEnvelope> {
  const t = await deps.peekTerminal(cursor.off)
  if (!t) throw sourceChanged("the terminal session is gone")
  if (t.pid !== cursor.pid) throw sourceChanged("the terminal session restarted (new process)")
  const warnings = t.sinceValid ? [] : ["scrollback trimmed — there is a gap before this page"]
  const { tail, truncated } = boundedTail(t.text)
  const fr = cursor.fr ?? null
  return {
    taskId: input.taskId,
    source: "terminal",
    terminal: { tail, truncated, live: t.live },
    cursor: encodeCursor({ v: 1, task: input.taskId, src: "terminal", pid: t.pid, off: t.offset, fr }),
    fallbackReason: fr,
    warnings,
  }
}

// ── Real deps + the verb ─────────────────────────────────────────────────────

/** Read-only ring peek of the task's hosted engine pane via `pty.peek`.
 *  Never spawns the host or a session; an old host without the verb (or
 *  any RPC hiccup) reads as "no terminal data". */
async function peekTaskTerminal(
  taskId: string,
  vendor: VendorId | undefined,
  sinceOffset?: number,
): Promise<TerminalPeekPage | null> {
  const host = await openPtyHost()
  if (!host) return null
  try {
    const engineBin = vendor ? interactiveEngineCommand(vendor)[0] : undefined
    const sessions = await listSessions(host.rpc)
    // findEngineKey only matches ALIVE sessions; a dead engine's retained
    // scrollback (how it died) is still worth reading, so fall back to the
    // deterministic engine-tab key the TUI always mints first.
    const key = findEngineKey(sessions, taskId, engineBin) ?? sessions.find((s) => s.key === `${taskId}::tab-1`)?.key
    if (!key) return null
    const res = await host.rpc.request<PtyPeekResult>("pty.peek", { key, sinceOffset })
    if (!res.exists) return null
    return {
      pid: res.pid,
      offset: res.offset,
      text: Buffer.from(res.data, "base64").toString("utf8"),
      sinceValid: res.sinceValid,
      live: res.alive,
    }
  } catch {
    return null
  } finally {
    host.close()
  }
}

async function handleReadOutput(ctx: VerbContext): Promise<unknown> {
  const daemon = daemonOf(ctx)
  let taskId = ctx.args.str("task-id")
  if (!taskId) {
    const active = await resolveActiveTaskId(daemon)
    if (!active) {
      throw new ApiError("no --task-id given and no active task — pass --task-id", "MISSING_TARGET")
    }
    taskId = active
  }
  const { task } = await daemon.request<{ task: SerializedTask }>("task.get", { taskId })
  const vendor = task.vendor as VendorId | undefined
  const deps: ReadOutputDeps = {
    history: vendor && supportsStructuredHistory(vendor) ? engineEntry(vendor).history : null,
    peekTerminal: (sinceOffset) => peekTaskTerminal(taskId, vendor, sinceOffset),
  }
  const envelope = await readTaskOutput(
    {
      taskId,
      worktree: task.worktreePath ?? null,
      source: ctx.args.enumOf<ReadSourceArg>("source") ?? "auto",
      cursor: ctx.args.str("cursor"),
      limit: ctx.args.int("limit"),
    },
    deps,
  )
  const running = await ctx.runtime.isTaskRunning(taskId)
  return { vendor: vendor ?? null, running, ...envelope }
}

export const READ_OUTPUT_VERB: VerbSpec = {
  name: "read-output",
  summary:
    "Read a task's engine output as bounded, cursor-paged JSON: the engine's own structured history when available, else a labeled terminal tail (typed fallbackReason). Read-only; the cursor stays pinned to one source/session (SOURCE_CHANGED when it moved).",
  flags: [
    {
      name: "task-id",
      type: "string",
      placeholder: "ID",
      description: "Target task id (defaults to the active task).",
    },
    {
      name: "source",
      type: "enum",
      values: ["auto", "history", "terminal"],
      default: "auto",
      description:
        "auto = structured history else terminal fallback; history = require structured (typed error instead of fallback); terminal = bounded terminal tail.",
    },
    {
      name: "cursor",
      type: "string",
      placeholder: "C",
      description: "Opaque cursor from the previous page. Pinned to that page's source and session.",
    },
    {
      name: "limit",
      type: "int",
      placeholder: "N",
      description: `History messages per page (default ${DEFAULT_PAGE_MESSAGES}, max ${MAX_PAGE_MESSAGES}).`,
    },
  ],
  handler: handleReadOutput,
}
