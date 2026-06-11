import { describe, expect, it } from "vitest"
import {
  type HistoryDeps,
  findLatestRolloutForWorktree,
  latestTranscriptMtimeForWorktree,
  listSessionIdsForWorktree,
} from "../../src/engine/codex-local/history.ts"
import { normalizeCodexContent } from "../../src/engine/codex-local/normalize.ts"
import { isSyntheticCodexUserRow, visibleCodexUserText } from "../../src/engine/codex-local/synthetic.ts"
import { codexUsageToSnapshot } from "../../src/engine/codex-local/usage.ts"

describe("normalizeCodexContent", () => {
  it("wraps a non-empty string as one text block", () => {
    expect(normalizeCodexContent("hi")).toEqual([{ type: "text", text: "hi" }])
  })

  it("returns [] for an empty string or a non-array value", () => {
    expect(normalizeCodexContent("")).toEqual([])
    expect(normalizeCodexContent(null)).toEqual([])
    expect(normalizeCodexContent(42)).toEqual([])
    expect(normalizeCodexContent({ type: "input_text", text: "x" })).toEqual([])
  })

  it("maps input_text / output_text to text blocks", () => {
    expect(
      normalizeCodexContent([
        { type: "input_text", text: "u" },
        { type: "output_text", text: "a" },
      ]),
    ).toEqual([
      { type: "text", text: "u" },
      { type: "text", text: "a" },
    ])
  })

  it("drops empty text and keeps bare string items", () => {
    expect(normalizeCodexContent([{ type: "input_text", text: "" }, "raw"])).toEqual([{ type: "text", text: "raw" }])
  })

  it("renders an unknown block type as a placeholder", () => {
    expect(normalizeCodexContent([{ type: "image" }])).toEqual([{ type: "text", text: "[codex: image]" }])
  })

  it("skips object items with no type", () => {
    expect(normalizeCodexContent([{ text: "no type" }])).toEqual([])
  })
})

describe("isSyntheticCodexUserRow", () => {
  it("is false for an empty list", () => {
    expect(isSyntheticCodexUserRow([])).toBe(false)
  })

  it("detects an environment_context envelope", () => {
    expect(isSyntheticCodexUserRow([{ type: "text", text: "<environment_context>cwd</environment_context>" }])).toBe(
      true,
    )
  })

  it("detects an AGENTS.md instructions envelope", () => {
    const text = "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nbe terse\n</INSTRUCTIONS>"
    expect(isSyntheticCodexUserRow([{ type: "text", text }])).toBe(true)
  })

  it("is false when a real block is mixed in with an envelope", () => {
    expect(
      isSyntheticCodexUserRow([
        { type: "text", text: "<environment_context>x</environment_context>" },
        { type: "text", text: "actual question" },
      ]),
    ).toBe(false)
  })

  it("is false for a non-text block", () => {
    expect(isSyntheticCodexUserRow([{ type: "image" }])).toBe(false)
  })
})

describe("visibleCodexUserText", () => {
  it("returns the real user text", () => {
    expect(visibleCodexUserText([{ type: "input_text", text: "real prompt" }])).toBe("real prompt")
    expect(visibleCodexUserText("plain")).toBe("plain")
  })

  it("returns null for a synthetic envelope row", () => {
    expect(
      visibleCodexUserText([{ type: "input_text", text: "<environment_context>x</environment_context>" }]),
    ).toBeNull()
  })

  it("returns null when there is no text", () => {
    expect(visibleCodexUserText([])).toBeNull()
  })
})

/**
 * The cwd memo matters because three pollers re-scan the rollout tree on
 * 1.5–4s intervals: without it every tick re-read up to 12–200 whole rollout
 * JSONLs just to re-derive each file's immutable first-line session_meta.cwd.
 * The cache is per-deps (WeakMap), so each test's fresh deps object is
 * isolated, and `""`/unreadable results are never pinned.
 */
describe("rollout cwd caching", () => {
  const meta = (cwd: string) => JSON.stringify({ type: "session_meta", payload: { id: "x", cwd } })

  function fakeDeps(files: Record<string, string>): { deps: HistoryDeps; reads: string[] } {
    const reads: string[] = []
    const names = Object.keys(files)
    const deps: HistoryDeps = {
      sessionsDir: () => "/sessions",
      readdir: async (p) => {
        if (p === "/sessions") return ["2026"]
        if (p === "/sessions/2026") return ["06"]
        if (p === "/sessions/2026/06") return ["10"]
        if (p === "/sessions/2026/06/10") return names
        return []
      },
      readFile: async (p) => {
        reads.push(p)
        const name = p.split("/").pop() ?? ""
        const raw = files[name]
        if (raw === undefined) throw new Error("ENOENT")
        return raw
      },
      stat: async () => ({ mtimeMs: 1234 }),
    }
    return { deps, reads }
  }

  it("latestTranscriptMtimeForWorktree reads each rollout's meta once across repeat polls", async () => {
    const { deps, reads } = fakeDeps({
      "rollout-2026-06-10T02-00-00-bbbbbbbb-1111-2222-3333-444444444444.jsonl": meta("/other"),
      "rollout-2026-06-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl": meta("/wt"),
    })
    expect(await latestTranscriptMtimeForWorktree("/wt", deps)).toBe(1234)
    expect(reads).toHaveLength(2) // newest-first: non-match probed, then the match
    expect(await latestTranscriptMtimeForWorktree("/wt", deps)).toBe(1234)
    expect(reads).toHaveLength(2) // repeat poll: zero file reads, cwds served from the memo
  })

  it("shares the memo with listSessionIdsForWorktree and findLatestRolloutForWorktree", async () => {
    const { deps, reads } = fakeDeps({
      "rollout-2026-06-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl": meta("/wt"),
    })
    expect(await listSessionIdsForWorktree("/wt", deps)).toEqual(["aaaaaaaa-1111-2222-3333-444444444444"])
    expect(await findLatestRolloutForWorktree("/wt", deps)).toEqual({
      path: "/sessions/2026/06/10/rollout-2026-06-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl",
      mtimeMs: 1234,
    })
    expect(reads).toHaveLength(1)
  })

  it("does not pin an empty cwd (a rollout caught mid-write is re-probed)", async () => {
    const files: Record<string, string> = {
      "rollout-2026-06-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl": "{not json yet",
    }
    const { deps, reads } = fakeDeps(files)
    expect(await latestTranscriptMtimeForWorktree("/wt", deps)).toBe(0)
    expect(reads).toHaveLength(1)
    // The writer finished the first line — the next poll must see it.
    files["rollout-2026-06-10T01-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl"] = meta("/wt")
    expect(await latestTranscriptMtimeForWorktree("/wt", deps)).toBe(1234)
    expect(reads).toHaveLength(2)
  })
})

describe("codexUsageToSnapshot", () => {
  it("subtracts cached input from total and reports the cache read", () => {
    expect(codexUsageToSnapshot({ input_tokens: 100, cached_input_tokens: 30, output_tokens: 50 })).toEqual({
      input_tokens: 70,
      output_tokens: 50,
      cache_read_input_tokens: 30,
    })
  })

  it("omits the cache field when nothing was cached", () => {
    expect(codexUsageToSnapshot({ input_tokens: 100, output_tokens: 50 })).toEqual({
      input_tokens: 100,
      output_tokens: 50,
    })
  })

  it("clamps non-cached input at zero", () => {
    expect(codexUsageToSnapshot({ input_tokens: 20, cached_input_tokens: 50 })).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 50,
    })
  })

  it("returns undefined when every counter is empty", () => {
    expect(codexUsageToSnapshot({})).toBeUndefined()
    expect(codexUsageToSnapshot({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })

  it("carries a positive context window through, ignoring non-positive", () => {
    expect(codexUsageToSnapshot({ output_tokens: 10 }, { contextWindowTokens: 200_000 })).toEqual({
      input_tokens: 0,
      output_tokens: 10,
      context_window_tokens: 200_000,
    })
    expect(codexUsageToSnapshot({ output_tokens: 10 }, { contextWindowTokens: 0 })).toEqual({
      input_tokens: 0,
      output_tokens: 10,
    })
  })
})
