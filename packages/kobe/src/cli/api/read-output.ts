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
 *
 * Tab precision (2026-08-16): the default terminal read resolves the
 * task's CANONICAL engine tab; `--tab tab-N` reads exactly that hosted
 * session instead (the API's smallest unit is one tab, same as
 * `send --tab`). A tab read is terminal-only — history is
 * worktree-scoped and cannot resolve to a tab — and the cursor pins
 * the tab alongside the pid, so paged reads can't silently hop tabs.
 */

import type { PtyPeekResult, SerializedTask } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { type EngineHistoryReader, engineEntry, supportsStructuredHistory } from "../../engine/registry.ts"
import type { Message } from "../../types/engine.ts"
import type { VendorId } from "../../types/vendor.ts"
import { daemonOf } from "./handler-helpers.ts"
import { findEngineKey, listSessions, openPtyHost } from "./pty-delivery.ts"
import {
  type Cursor,
  DEFAULT_PAGE_MESSAGES,
  type FallbackReason,
  type HistoryCursor,
  MAX_PAGE_MESSAGES,
  type ReadOutputEnvelope,
  type ReadSourceArg,
  type TerminalCursor,
  type TerminalPeekPage,
  boundedTail,
  buildHistoryPage,
  decodeCursor,
  encodeCursor,
} from "./read-output-page.ts"
import { resolveActiveTaskId } from "./runtime.ts"
import { ApiError, type VerbContext, type VerbSpec } from "./types.ts"

// The paging/shaping half lives in `read-output-page.ts` (file-size cap);
// re-exported so `@/cli/api/read-output` stays the one import site.
export {
  boundedTail,
  buildHistoryPage,
  clipStrings,
  decodeCursor,
  DEFAULT_PAGE_MESSAGES,
  encodeCursor,
  MAX_PAGE_MESSAGES,
  STRING_CLIP_CHARS,
  TERMINAL_TAIL_BYTES,
  TERMINAL_TAIL_LINES,
} from "./read-output-page.ts"
export type {
  Cursor,
  FallbackReason,
  HistoryPage,
  ReadOutputEnvelope,
  ReadSource,
  ReadSourceArg,
  TerminalPeekPage,
  TerminalTail,
} from "./read-output-page.ts"

// ── The read itself (deps-injected, unit-testable) ───────────────────────────

export interface ReadOutputDeps {
  /** The engine adapter's transcript reader; null = engine ships none. */
  readonly history: EngineHistoryReader | null
  /** Bounded ring peek of one hosted session; `tab` selects the exact tab
   *  (`undefined` = the task's canonical engine tab). null = no host / no
   *  session. */
  peekTerminal(tab: string | undefined, sinceOffset?: number): Promise<TerminalPeekPage | null>
}

export interface ReadOutputInput {
  readonly taskId: string
  /** Task worktree (null when not materialized — history is then missing). */
  readonly worktree: string | null
  readonly source: ReadSourceArg
  /** Exact terminal tab to read (`tab-N`); implies a terminal-only read. */
  readonly tab?: string
  readonly cursor?: string
  readonly limit?: number
}

function sourceChanged(detail: string): ApiError {
  return new ApiError(`${detail} — restart the read without the cursor`, "SOURCE_CHANGED")
}

export async function readTaskOutput(input: ReadOutputInput, deps: ReadOutputDeps): Promise<ReadOutputEnvelope> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_MESSAGES, 1), MAX_PAGE_MESSAGES)

  // A tab read IS a terminal read: history is worktree-scoped, so there is
  // no per-tab history to serve. --source history + --tab is a contradiction.
  if (input.tab && input.source === "history") {
    throw new ApiError("--tab reads one terminal tab; --source history is task/worktree-scoped", "BAD_FLAG")
  }

  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, input.taskId)
    if (input.source !== "auto" && input.source !== cursor.src) {
      throw new ApiError(
        `cursor is pinned to source "${cursor.src}" but --source is "${input.source}"`,
        "CURSOR_INVALID",
      )
    }
    if (input.tab && cursor.src !== "terminal") {
      throw new ApiError(`cursor is pinned to source "${cursor.src}" but --tab reads a terminal tab`, "CURSOR_INVALID")
    }
    if (cursor.src === "terminal" && (cursor.tab ?? null) !== (input.tab ?? null)) {
      throw new ApiError(
        `cursor is pinned to tab ${cursor.tab ?? "canonical"} — pass the same --tab or restart without the cursor`,
        "CURSOR_INVALID",
      )
    }
    return cursor.src === "history"
      ? continueHistory(input, deps, cursor, limit)
      : continueTerminal(input, deps, cursor)
  }

  if (input.tab || input.source === "terminal") return firstTerminalPage(input, deps, null)

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
  const t = await deps.peekTerminal(input.tab)
  if (!t) {
    return {
      taskId: input.taskId,
      source: "terminal",
      terminal: { tail: [], truncated: false, live: false, tab: input.tab },
      cursor: null,
      fallbackReason,
      warnings: ["no live terminal session for this task"],
    }
  }
  const { tail, truncated } = boundedTail(t.text)
  return {
    taskId: input.taskId,
    source: "terminal",
    terminal: { tail, truncated, live: t.live, exit: t.exit ?? null, tab: input.tab },
    cursor: encodeCursor({
      v: 1,
      task: input.taskId,
      src: "terminal",
      pid: t.pid,
      off: t.offset,
      fr: fallbackReason,
      tab: input.tab,
    }),
    fallbackReason,
    warnings: [],
  }
}

async function continueTerminal(
  input: ReadOutputInput,
  deps: ReadOutputDeps,
  cursor: TerminalCursor,
): Promise<ReadOutputEnvelope> {
  const t = await deps.peekTerminal(cursor.tab, cursor.off)
  if (!t) throw sourceChanged("the terminal session is gone")
  if (t.pid !== cursor.pid) throw sourceChanged("the terminal session restarted (new process)")
  const warnings = t.sinceValid ? [] : ["scrollback trimmed — there is a gap before this page"]
  const { tail, truncated } = boundedTail(t.text)
  const fr = cursor.fr ?? null
  return {
    taskId: input.taskId,
    source: "terminal",
    terminal: { tail, truncated, live: t.live, exit: t.exit ?? null, tab: cursor.tab },
    cursor: encodeCursor({ v: 1, task: input.taskId, src: "terminal", pid: t.pid, off: t.offset, fr, tab: cursor.tab }),
    fallbackReason: fr,
    warnings,
  }
}

// ── Real deps + the verb ─────────────────────────────────────────────────────

/** Read-only ring peek of one hosted session via `pty.peek`. Never spawns
 *  the host or a session; an old host without the verb (or any RPC hiccup)
 *  reads as "no terminal data".
 *
 *  `tab` selects the exact session key `<taskId>::<tab>`; an explicit tab
 *  whose key the host doesn't know is a typed TAB_NOT_FOUND, not an empty
 *  read. Without it, the canonical engine tab: findEngineKey only matches
 *  ALIVE sessions; a dead engine's retained scrollback (how it died) is
 *  still worth reading, so fall back to the deterministic engine-tab key
 *  the TUI always mints first. */
async function peekTaskTerminal(
  taskId: string,
  vendor: VendorId | undefined,
  tab: string | undefined,
  sinceOffset?: number,
): Promise<TerminalPeekPage | null> {
  const host = await openPtyHost()
  if (!host) return null
  try {
    let key: string | undefined
    if (tab) {
      key = `${taskId}::${tab}`
    } else {
      const engineBin = vendor ? interactiveEngineCommand(vendor)[0] : undefined
      const sessions = await listSessions(host.rpc)
      key = findEngineKey(sessions, taskId, engineBin) ?? sessions.find((s) => s.key === `${taskId}::tab-1`)?.key
    }
    if (!key) return null
    const res = await host.rpc.request<PtyPeekResult>("pty.peek", { key, sinceOffset })
    if (!res.exists) {
      if (tab) {
        throw new ApiError(
          `tab ${tab} has no hosted session on task ${taskId} — see \`rove api pty-list\` for live tabs`,
          "TAB_NOT_FOUND",
        )
      }
      return null
    }
    return {
      pid: res.pid,
      offset: res.offset,
      text: Buffer.from(res.data, "base64").toString("utf8"),
      sinceValid: res.sinceValid,
      live: res.alive,
      exit: res.exit ?? null,
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
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
  const tab = ctx.args.str("tab")
  const deps: ReadOutputDeps = {
    history: vendor && supportsStructuredHistory(vendor) ? engineEntry(vendor).history : null,
    peekTerminal: (tabId, sinceOffset) => peekTaskTerminal(taskId, vendor, tabId, sinceOffset),
  }
  const envelope = await readTaskOutput(
    {
      taskId,
      worktree: task.worktreePath ?? null,
      source: ctx.args.enumOf<ReadSourceArg>("source") ?? "auto",
      tab,
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
    "Read a task's engine output as bounded, cursor-paged JSON: the engine's own structured history when available, else a labeled terminal tail (typed fallbackReason). --tab tab-N reads one exact terminal tab. Read-only; the cursor stays pinned to one source/session/tab (SOURCE_CHANGED when it moved).",
  flags: [
    {
      name: "task-id",
      type: "string",
      placeholder: "ID",
      description: "Target task id (defaults to the active task).",
    },
    {
      name: "tab",
      type: "string",
      placeholder: "TAB",
      description:
        "Read exactly this terminal tab's hosted session (e.g. tab-3) instead of the canonical engine tab. Terminal-only read; cannot combine with --source history.",
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
