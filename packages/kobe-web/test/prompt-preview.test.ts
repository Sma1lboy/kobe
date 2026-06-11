import { beforeEach, describe, expect, it } from "vitest"
import type { ContentBlock, HistoryMessage } from "../src/lib/history.ts"
import {
  collapsePreviewLine,
  extractPromptPreview,
  getPromptPreviews,
  loadPromptPreview,
  PREVIEW_MAX_CHARS,
  type PreviewFetchers,
  prunePromptPreviews,
  resetPromptPreviews,
} from "../src/lib/prompt-preview.ts"

// Why this matters: the Overview card preview answers "which task is this
// again?" at a glance. The extraction must show the last thing the user
// actually TYPED — not Codex's tool-result plumbing on role:"user" records,
// not assistant prose — and the store must stay cheap (mtime-gated) so the
// triage view never re-downloads an unchanged transcript.

function msg(
  role: HistoryMessage["role"],
  blocks: ContentBlock[],
): HistoryMessage {
  return { role, blocks, timestamp: "2026-06-11T00:00:00Z", sessionId: "s1" }
}

const text = (t: string): ContentBlock => ({ type: "text", text: t })
const toolResult: ContentBlock = {
  type: "tool_result",
  callId: "c1",
  output: "ok",
  isError: false,
}

describe("collapsePreviewLine", () => {
  it("collapses newlines and runs of whitespace to single spaces", () => {
    expect(collapsePreviewLine("  fix\n\nthe   bug\t now ")).toBe(
      "fix the bug now",
    )
  })

  it("caps long prompts with an ellipsis", () => {
    const long = "x".repeat(PREVIEW_MAX_CHARS + 50)
    const out = collapsePreviewLine(long)
    expect(out.endsWith("…")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1)
  })
})

describe("extractPromptPreview", () => {
  it("returns the LAST user prompt", () => {
    const preview = extractPromptPreview([
      msg("user", [text("first ask")]),
      msg("assistant", [text("done")]),
      msg("user", [text("second ask")]),
    ])
    expect(preview).toBe("second ask")
  })

  it("skips tool_result-only user records (Codex plumbing) back to real prose", () => {
    const preview = extractPromptPreview([
      msg("user", [text("real prompt")]),
      msg("assistant", [text("working…")]),
      msg("user", [toolResult]),
      msg("user", [toolResult]),
    ])
    expect(preview).toBe("real prompt")
  })

  it("never previews assistant or system text", () => {
    const preview = extractPromptPreview([
      msg("system", [text("session start")]),
      msg("assistant", [text("hello, how can I help?")]),
    ])
    expect(preview).toBeNull()
  })

  it("skips whitespace-only user text", () => {
    const preview = extractPromptPreview([
      msg("user", [text("the actual ask")]),
      msg("user", [text("   \n  ")]),
    ])
    expect(preview).toBe("the actual ask")
  })

  it("returns null for an empty transcript", () => {
    expect(extractPromptPreview([])).toBeNull()
  })
})

describe("loadPromptPreview (mtime-gated store)", () => {
  beforeEach(() => {
    resetPromptPreviews()
  })

  function makeFetchers(opts: {
    mtime: number
    sessions?: string[]
    messages?: HistoryMessage[]
  }) {
    const calls = { sessions: 0, messages: 0, vendors: [] as string[] }
    const fetchers: PreviewFetchers = {
      sessions: (_worktreePath, vendor) => {
        calls.sessions++
        calls.vendors.push(vendor)
        return Promise.resolve({
          sessions: opts.sessions ?? ["s1"],
          latestMtime: opts.mtime,
        })
      },
      messages: () => {
        calls.messages++
        return Promise.resolve(opts.messages ?? [msg("user", [text("hi")])])
      },
    }
    return { fetchers, calls }
  }

  const task = { id: "t1", worktreePath: "/wt/t1", vendor: "claude" }

  it("fetches and publishes a preview", async () => {
    const { fetchers } = makeFetchers({
      mtime: 100,
      messages: [msg("user", [text("ship the rail fix")])],
    })
    await loadPromptPreview(task, fetchers)
    expect(getPromptPreviews()).toEqual({ t1: "ship the rail fix" })
  })

  it("does not re-download messages when the transcript mtime is unchanged", async () => {
    const { fetchers, calls } = makeFetchers({ mtime: 100 })
    await loadPromptPreview(task, fetchers)
    await loadPromptPreview(task, fetchers)
    expect(calls.sessions).toBe(2)
    expect(calls.messages).toBe(1)
  })

  it("re-downloads when the mtime changed", async () => {
    const first = makeFetchers({
      mtime: 100,
      messages: [msg("user", [text("old ask")])],
    })
    await loadPromptPreview(task, first.fetchers)
    const second = makeFetchers({
      mtime: 200,
      messages: [msg("user", [text("new ask")])],
    })
    await loadPromptPreview(task, second.fetchers)
    expect(second.calls.messages).toBe(1)
    expect(getPromptPreviews()).toEqual({ t1: "new ask" })
  })

  it("publishes null when the worktree has no sessions yet", async () => {
    const { fetchers, calls } = makeFetchers({ mtime: 0, sessions: [] })
    await loadPromptPreview(task, fetchers)
    expect(calls.messages).toBe(0)
    expect(getPromptPreviews()).toEqual({ t1: null })
  })

  it("swallows fetch errors (garnish semantics) and retries next call", async () => {
    const failing: PreviewFetchers = {
      sessions: () => Promise.reject(new Error("bridge down")),
      messages: () => Promise.reject(new Error("unreachable")),
    }
    await expect(loadPromptPreview(task, failing)).resolves.toBeUndefined()
    expect(getPromptPreviews()).toEqual({})
    // The failure must not wedge the in-flight guard.
    const { fetchers } = makeFetchers({
      mtime: 100,
      messages: [msg("user", [text("recovered")])],
    })
    await loadPromptPreview(task, fetchers)
    expect(getPromptPreviews()).toEqual({ t1: "recovered" })
  })

  it("dedupes concurrent loads for the same task", async () => {
    let release: (() => void) | undefined
    const calls = { sessions: 0 }
    const fetchers: PreviewFetchers = {
      sessions: () => {
        calls.sessions++
        return new Promise((resolve) => {
          release = () =>
            resolve({ sessions: ["s1"], latestMtime: 100 })
        })
      },
      messages: () => Promise.resolve([msg("user", [text("hi")])]),
    }
    const a = loadPromptPreview(task, fetchers)
    const b = loadPromptPreview(task, fetchers)
    release?.()
    await Promise.all([a, b])
    expect(calls.sessions).toBe(1)
  })

  it("skips tasks without a worktree path", async () => {
    const { fetchers, calls } = makeFetchers({ mtime: 100 })
    await loadPromptPreview({ id: "t2", worktreePath: "" }, fetchers)
    expect(calls.sessions).toBe(0)
  })

  it("defaults the vendor to claude, mirroring the bridge route", async () => {
    const { fetchers, calls } = makeFetchers({ mtime: 100 })
    await loadPromptPreview({ id: "t3", worktreePath: "/wt/t3" }, fetchers)
    expect(calls.vendors).toEqual(["claude"])
  })

  it("treats latestMtime 0 as unknown, not a cacheable version", async () => {
    // The codex reader's mtime probe is scan-capped: it can return 0 for a
    // LIVE transcript with non-empty sessions. A 0===0 cache hit would freeze
    // the preview forever, so 0 must always re-derive.
    const first = makeFetchers({
      mtime: 0,
      messages: [msg("user", [text("old ask")])],
    })
    await loadPromptPreview(task, first.fetchers)
    const second = makeFetchers({
      mtime: 0,
      messages: [msg("user", [text("newer ask, same capped mtime")])],
    })
    await loadPromptPreview(task, second.fetchers)
    expect(second.calls.messages).toBe(1)
    expect(getPromptPreviews()).toEqual({ t1: "newer ask, same capped mtime" })
  })

  it("prunes entries for tasks that no longer exist", async () => {
    const { fetchers } = makeFetchers({
      mtime: 100,
      messages: [msg("user", [text("hi")])],
    })
    await loadPromptPreview(task, fetchers)
    await loadPromptPreview(
      { id: "t2", worktreePath: "/wt/t2", vendor: "claude" },
      fetchers,
    )
    prunePromptPreviews(new Set(["t2"]))
    expect(getPromptPreviews()).toEqual({ t2: "hi" })
  })

  it("a load racing a delete does not re-insert the dead id", async () => {
    let release: (() => void) | undefined
    const fetchers: PreviewFetchers = {
      sessions: () =>
        new Promise((resolve) => {
          release = () => resolve({ sessions: ["s1"], latestMtime: 100 })
        }),
      messages: () => Promise.resolve([msg("user", [text("hi")])]),
    }
    const load = loadPromptPreview(task, fetchers)
    // task.snapshot lands mid-flight: t1 was deleted.
    prunePromptPreviews(new Set(["other"]))
    release?.()
    await load
    expect(getPromptPreviews()).toEqual({})
  })
})
