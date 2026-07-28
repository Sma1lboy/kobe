/**
 * `kobe api read-output` core rules — pagination, fallback labeling, and
 * cursor pinning (the contract an external coordinator scripts against).
 * Runs the pure `readTaskOutput` against fake deps; no daemon, PTY host,
 * or vendor transcript files.
 */

import { describe, expect, it } from "vitest"
import {
  DEFAULT_PAGE_MESSAGES,
  MAX_PAGE_MESSAGES,
  type ReadOutputDeps,
  type ReadOutputEnvelope,
  STRING_CLIP_CHARS,
  TERMINAL_TAIL_LINES,
  type TerminalPeekPage,
  boundedTail,
  clipStrings,
  readTaskOutput,
} from "../../src/cli/api/read-output.ts"
import type { EngineHistoryReader } from "../../src/engine/registry.ts"
import type { Message } from "../../src/types/engine.ts"
import { expectApiError } from "./api-handler-fixtures.ts"

const WORKTREE = "/wt/task-1"

function msg(text: string): Message {
  return {
    role: "assistant",
    blocks: [{ type: "text", text }] as unknown as Message["blocks"],
    timestamp: "2026-07-27T00:00:00Z",
    sessionId: "s-current",
  }
}

function fakeHistory(
  sessions: readonly string[],
  bySession: Record<string, readonly Message[]>,
  calls?: string[],
): EngineHistoryReader {
  return {
    async listSessionIdsForWorktree() {
      calls?.push("list")
      return sessions
    },
    async readHistory(sessionId) {
      calls?.push(`read:${sessionId}`)
      return [...(bySession[sessionId] ?? [])]
    },
    async latestTranscriptMtimeForWorktree() {
      return 0
    },
  }
}

function noTerminal(): ReadOutputDeps["peekTerminal"] {
  return async () => null
}

function fakeTerminal(pages: {
  pid: number | null
  offset: number
  text: string
  sinceValid?: boolean
  live?: boolean
}): { peek: ReadOutputDeps["peekTerminal"]; offsets: Array<number | undefined> } {
  const offsets: Array<number | undefined> = []
  const peek: ReadOutputDeps["peekTerminal"] = async (sinceOffset) => {
    offsets.push(sinceOffset)
    return {
      pid: pages.pid,
      offset: pages.offset,
      text: pages.text,
      sinceValid: pages.sinceValid ?? true,
      live: pages.live ?? true,
    } satisfies TerminalPeekPage
  }
  return { peek, offsets }
}

function deps(history: EngineHistoryReader | null, peekTerminal: ReadOutputDeps["peekTerminal"]): ReadOutputDeps {
  return { history, peekTerminal }
}

async function read(
  d: ReadOutputDeps,
  over: Partial<{
    taskId: string
    worktree: string | null
    source: "auto" | "history" | "terminal"
    cursor: string
    limit: number
  }> = {},
): Promise<ReadOutputEnvelope> {
  return readTaskOutput(
    {
      taskId: over.taskId ?? "t1",
      worktree: over.worktree === undefined ? WORKTREE : over.worktree,
      source: over.source ?? "auto",
      cursor: over.cursor,
      limit: over.limit,
    },
    d,
  )
}

describe("read-output history paging", () => {
  const messages = Array.from({ length: 100 }, (_, i) => msg(`m${i}`))
  const history = fakeHistory(["s-old", "s-current"], { "s-current": messages })

  it("reads the newest session and pages deterministically through the cursor", async () => {
    const d = deps(history, noTerminal())
    const p1 = await read(d)
    expect(p1.source).toBe("history")
    expect(p1.fallbackReason).toBeNull()
    expect(p1.history?.sessionId).toBe("s-current")
    expect(p1.history?.returnedMessageCount).toBe(DEFAULT_PAGE_MESSAGES)
    expect(p1.history?.totalMessages).toBe(100)
    expect(p1.cursor).toBeTruthy()

    const p2 = await read(d, { cursor: p1.cursor ?? undefined })
    const p3 = await read(d, { cursor: p2.cursor ?? undefined })
    const texts = [p1, p2, p3].flatMap((p) =>
      (p.history?.messages ?? []).map((m) => (m as { blocks: Array<{ text: string }> }).blocks[0]?.text),
    )
    expect(texts).toEqual(messages.map((_, i) => `m${i}`))
    expect(p3.history?.returnedMessageCount).toBe(20)

    // Exhausted pages still return a cursor (the session may keep appending).
    const p4 = await read(d, { cursor: p3.cursor ?? undefined })
    expect(p4.history?.returnedMessageCount).toBe(0)
    expect(p4.cursor).toBeTruthy()
  })

  it("clamps --limit to the page cap", async () => {
    const p = await read(deps(history, noTerminal()), { limit: 500 })
    expect(p.history?.returnedMessageCount).toBe(MAX_PAGE_MESSAGES)
  })

  it("cuts a page short on the byte budget and flags it limited", async () => {
    const big = Array.from({ length: 30 }, (_, i) => msg("x".repeat(15_000) + i))
    const d = deps(fakeHistory(["s-current"], { "s-current": big }), noTerminal())
    const p = await read(d)
    expect(p.history?.limited).toBe(true)
    expect(p.history?.returnedMessageCount).toBeGreaterThan(0)
    expect(p.history?.returnedMessageCount).toBeLessThan(30)
    // The next page resumes exactly where the budget stopped.
    const p2 = await read(d, { cursor: p.cursor ?? undefined })
    const first = (p2.history?.messages[0] as { blocks: Array<{ text: string }> }).blocks[0]?.text
    expect(first?.endsWith(String(p.history?.returnedMessageCount))).toBe(true)
  })

  it("clips oversized strings inside messages", () => {
    const clipped = clipStrings({ text: "y".repeat(STRING_CLIP_CHARS + 500) }) as { text: string }
    expect(clipped.text.length).toBeLessThan(STRING_CLIP_CHARS + 100)
    expect(clipped.text).toContain("chars clipped]")
  })
})

describe("read-output fallback labeling", () => {
  it("labels engine_unsupported when the adapter ships no reader", async () => {
    const p = await read(deps(null, noTerminal()))
    expect(p.source).toBe("terminal")
    expect(p.fallbackReason).toBe("engine_unsupported")
    expect(p.terminal?.tail).toEqual([])
    expect(p.cursor).toBeNull()
    expect(p.warnings.length).toBe(1)
  })

  it("labels history_missing when the worktree has no sessions (or no worktree)", async () => {
    const p = await read(deps(fakeHistory([], {}), noTerminal()))
    expect(p.fallbackReason).toBe("history_missing")
    const p2 = await read(deps(fakeHistory(["s"], {}), noTerminal()), { worktree: null })
    expect(p2.fallbackReason).toBe("history_missing")
  })

  it("labels history_unreadable when the reader throws", async () => {
    const broken: EngineHistoryReader = {
      listSessionIdsForWorktree: async () => {
        throw new Error("boom")
      },
      readHistory: async () => [],
      latestTranscriptMtimeForWorktree: async () => 0,
    }
    const p = await read(deps(broken, noTerminal()))
    expect(p.fallbackReason).toBe("history_unreadable")
  })

  it("--source history returns a typed error instead of falling back", async () => {
    await expectApiError(() => read(deps(null, noTerminal()), { source: "history" }), "HISTORY_REQUIRED")
  })

  it("--source terminal never probes history and carries no fallbackReason", async () => {
    const calls: string[] = []
    const history = fakeHistory(["s-current"], { "s-current": [msg("hi")] }, calls)
    const t = fakeTerminal({ pid: 42, offset: 10, text: "hello\n" })
    const p = await read(deps(history, t.peek), { source: "terminal" })
    expect(p.source).toBe("terminal")
    expect(p.fallbackReason).toBeNull()
    expect(p.terminal?.tail).toContain("hello")
    expect(calls).toEqual([])
  })
})

describe("read-output cursor rules", () => {
  const history = fakeHistory(["s-current"], { "s-current": [msg("a"), msg("b")] })

  it("rejects garbage and mismatched-task cursors", async () => {
    const d = deps(history, noTerminal())
    await expectApiError(() => read(d, { cursor: "not-a-cursor!!" }), "CURSOR_INVALID")
    const p = await read(d)
    await expectApiError(() => read(d, { cursor: p.cursor ?? undefined, taskId: "other" }), "CURSOR_TASK_MISMATCH")
  })

  it("rejects a cursor whose pinned source conflicts with an explicit --source", async () => {
    const d = deps(history, noTerminal())
    const p = await read(d)
    await expectApiError(() => read(d, { cursor: p.cursor ?? undefined, source: "terminal" }), "CURSOR_INVALID")
  })

  it("returns SOURCE_CHANGED when the pinned session was replaced", async () => {
    const d = deps(history, noTerminal())
    const p = await read(d)
    const replaced = deps(fakeHistory(["s-current", "s-new"], { "s-new": [msg("n")] }), noTerminal())
    await expectApiError(() => read(replaced, { cursor: p.cursor ?? undefined }), "SOURCE_CHANGED")
  })

  it("returns SOURCE_CHANGED when the pinned transcript shrank", async () => {
    const long = fakeHistory(["s-current"], { "s-current": Array.from({ length: 5 }, (_, i) => msg(`m${i}`)) })
    const p = await read(deps(long, noTerminal()))
    const shrunk = deps(fakeHistory(["s-current"], { "s-current": [msg("m0")] }), noTerminal())
    await expectApiError(() => read(shrunk, { cursor: p.cursor ?? undefined }), "SOURCE_CHANGED")
  })

  it("terminal cursors pin the process incarnation", async () => {
    const t1 = fakeTerminal({ pid: 42, offset: 100, text: "one\n" })
    const d1 = deps(null, t1.peek)
    const p1 = await read(d1, { source: "terminal" })
    expect(t1.offsets).toEqual([undefined])

    // Continuation passes the pinned offset through to the peek.
    const t2 = fakeTerminal({ pid: 42, offset: 160, text: "two\n" })
    const p2 = await read(deps(null, t2.peek), { cursor: p1.cursor ?? undefined })
    expect(t2.offsets).toEqual([100])
    expect(p2.terminal?.tail).toContain("two")

    // A new pid = a new incarnation: typed error, never silent switching.
    const t3 = fakeTerminal({ pid: 43, offset: 5, text: "other\n" })
    await expectApiError(() => read(deps(null, t3.peek), { cursor: p2.cursor ?? undefined }), "SOURCE_CHANGED")

    // Session gone on continuation is also SOURCE_CHANGED, not a fresh read.
    await expectApiError(() => read(deps(null, noTerminal()), { cursor: p2.cursor ?? undefined }), "SOURCE_CHANGED")
  })

  it("warns (not errors) when the ring trimmed past the pinned offset", async () => {
    const t1 = fakeTerminal({ pid: 42, offset: 100, text: "one\n" })
    const p1 = await read(deps(null, t1.peek), { source: "terminal" })
    const trimmed = fakeTerminal({ pid: 42, offset: 900, text: "late\n", sinceValid: false })
    const p2 = await read(deps(null, trimmed.peek), { cursor: p1.cursor ?? undefined })
    expect(p2.warnings.some((w) => w.includes("gap"))).toBe(true)
  })

  it("keeps the fallback label across terminal-cursor continuations", async () => {
    const t = fakeTerminal({ pid: 42, offset: 10, text: "x\n" })
    const p1 = await read(deps(null, t.peek))
    expect(p1.fallbackReason).toBe("engine_unsupported")
    const p2 = await read(deps(null, fakeTerminal({ pid: 42, offset: 20, text: "y\n" }).peek), {
      cursor: p1.cursor ?? undefined,
    })
    expect(p2.fallbackReason).toBe("engine_unsupported")
  })

  it("never leaks paths: cursors and envelopes carry no worktree or transcript path", async () => {
    const p = await read(deps(history, noTerminal()))
    const decoded = Buffer.from(p.cursor ?? "", "base64url").toString("utf8")
    expect(decoded).not.toContain(WORKTREE)
    expect(decoded).not.toContain("/")
    expect(JSON.stringify(p)).not.toContain(WORKTREE)
  })
})

describe("read-output terminal tail shaping", () => {
  it("strips ANSI, honors CR overwrites, and caps the line count", () => {
    const noisy = "\x1b[31mred\x1b[0m line\r\nprogress 1\rprogress 2\n\x1b]0;title\x07plain\n"
    const shaped = boundedTail(noisy)
    expect(shaped.tail).toContain("red line")
    expect(shaped.tail).toContain("progress 2")
    expect(shaped.tail).toContain("plain")
    expect(shaped.tail.join("\n")).not.toContain("\x1b")

    const many = Array.from({ length: TERMINAL_TAIL_LINES + 50 }, (_, i) => `l${i}`).join("\n")
    const capped = boundedTail(many)
    expect(capped.tail.length).toBe(TERMINAL_TAIL_LINES)
    expect(capped.truncated).toBe(true)
    expect(capped.tail[0]).toBe("l50")
  })
})
