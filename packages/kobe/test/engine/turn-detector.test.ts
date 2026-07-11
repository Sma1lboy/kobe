import { describe, expect, test } from "vitest"
import {
  ClaudeTurnDetector,
  CodexTurnDetector,
  createEngineTurnDetector,
  latestClaudeCompletionMarkerFromJsonl,
  latestCodexCompletionMarkerFromJsonl,
} from "../../src/engine/turn-detector"

describe("latestCodexCompletionMarkerFromJsonl", () => {
  test("uses turn.completed as the completion marker (legacy exec --json stream)", () => {
    const raw = [
      JSON.stringify({ type: "response_item", timestamp: "2026-05-29T01:00:00.000Z" }),
      JSON.stringify({ type: "turn.completed", timestamp: "2026-05-29T01:00:03.000Z", usage: { input_tokens: 1 } }),
    ].join("\n")
    const marker = latestCodexCompletionMarkerFromJsonl(raw, "rollout")
    expect(marker?.source).toBe("codex")
    expect(marker?.timestampMs).toBe(Date.parse("2026-05-29T01:00:03.000Z"))
  })

  // The bug: a REAL codex rollout never writes a top-level `turn.completed` —
  // completion is an `event_msg` whose flattened EventMsg tag is task_complete /
  // turn_complete / turn_aborted. Without this arm codex turns never reached
  // "done" (background toast / unread badge never fired).
  test("recognizes an event_msg task_complete as the completion marker (real rollout)", () => {
    const raw = [
      JSON.stringify({ type: "response_item", timestamp: "2026-05-29T01:00:00.000Z", payload: { type: "message" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-05-29T01:00:05.000Z", payload: { type: "task_complete" } }),
    ].join("\n")
    const marker = latestCodexCompletionMarkerFromJsonl(raw, "rollout")
    expect(marker?.source).toBe("codex")
    expect(marker?.timestampMs).toBe(Date.parse("2026-05-29T01:00:05.000Z"))
  })

  test("also accepts the turn_complete alias and turn_aborted", () => {
    for (const type of ["turn_complete", "turn_aborted"]) {
      const raw = JSON.stringify({ type: "event_msg", timestamp: "2026-05-29T01:00:06.000Z", payload: { type } })
      expect(latestCodexCompletionMarkerFromJsonl(raw)?.timestampMs).toBe(Date.parse("2026-05-29T01:00:06.000Z"))
    }
  })

  test("ignores non-completion event_msg records (token_count, etc.)", () => {
    const raw = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-05-29T01:00:07.000Z",
      payload: { type: "token_count", info: null },
    })
    expect(latestCodexCompletionMarkerFromJsonl(raw)).toBeNull()
  })
})

describe("latestClaudeCompletionMarkerFromJsonl", () => {
  test("uses assistant transcript records as completion markers", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-29T01:00:00.000Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-29T01:00:04.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ].join("\n")
    const marker = latestClaudeCompletionMarkerFromJsonl(raw, "session")
    expect(marker?.source).toBe("claude")
    expect(marker?.timestampMs).toBe(Date.parse("2026-05-29T01:00:04.000Z"))
  })
})

describe("createEngineTurnDetector", () => {
  test("keeps unsupported vendors behind the same abstraction", () => {
    const detector = createEngineTurnDetector("copilot")
    expect(detector.vendor).toBe("copilot")
    expect(detector.supportsCompletionMarkers()).toBe(false)
  })
})

// The mtime gate matters because the Ops pane calls latestCompletion from a
// 1.5s poll for the whole pane lifetime: without it every poll re-read and
// re-parsed multi-MB session JSONLs that hadn't changed. The cache must be
// invisible (same markers as a fresh parse) and keyed strictly on mtime.
describe("ClaudeTurnDetector mtime gating", () => {
  const record = (ts: string) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [] } })

  test("skips re-reading transcripts whose mtime is unchanged, and returns the identical marker", async () => {
    const reads: string[] = []
    let mtime = 1000
    const detector = new ClaudeTurnDetector({
      listSessionFiles: async () => [{ sessionId: "s1", path: "/p/s1.jsonl", mtimeMs: mtime }],
      readFile: async (p) => {
        reads.push(p)
        return record("2026-05-29T01:00:04.000Z")
      },
    })

    const first = await detector.latestCompletion("/wt")
    const second = await detector.latestCompletion("/wt")
    expect(reads).toHaveLength(1) // second poll served from the mtime memo
    expect(second).toEqual(first)

    mtime = 2000 // the engine appended — mtime advanced, must re-read
    await detector.latestCompletion("/wt")
    expect(reads).toHaveLength(2)
  })

  test("never trusts mtime 0 (the lister's stat failed) as a cache key", async () => {
    const reads: string[] = []
    const detector = new ClaudeTurnDetector({
      listSessionFiles: async () => [{ sessionId: "s1", path: "/p/s1.jsonl", mtimeMs: 0 }],
      readFile: async (p) => {
        reads.push(p)
        return record("2026-05-29T01:00:04.000Z")
      },
    })
    await detector.latestCompletion("/wt")
    await detector.latestCompletion("/wt")
    expect(reads).toHaveLength(2)
  })
})

describe("CodexTurnDetector mtime gating", () => {
  test("skips re-reading the matched rollout when its mtime is unchanged", async () => {
    const reads: string[] = []
    let mtime = 1000
    const detector = new CodexTurnDetector({
      findLatestRollout: async () => ({ path: "/r/rollout.jsonl", mtimeMs: mtime }),
      readFile: async (p) => {
        reads.push(p)
        return JSON.stringify({ type: "turn.completed", timestamp: "2026-05-29T01:00:03.000Z", usage: {} })
      },
    })

    const first = await detector.latestCompletion("/wt")
    const second = await detector.latestCompletion("/wt")
    expect(reads).toHaveLength(1)
    expect(second).toEqual(first)
    expect(first?.source).toBe("codex")

    mtime = 2000
    await detector.latestCompletion("/wt")
    expect(reads).toHaveLength(2)
  })

  test("a null marker (no turn.completed yet) is cached under the same mtime gate", async () => {
    const reads: string[] = []
    const detector = new CodexTurnDetector({
      findLatestRollout: async () => ({ path: "/r/rollout.jsonl", mtimeMs: 1000 }),
      readFile: async (p) => {
        reads.push(p)
        return JSON.stringify({ type: "response_item", timestamp: "2026-05-29T01:00:00.000Z" })
      },
    })
    expect(await detector.latestCompletion("/wt")).toBeNull()
    expect(await detector.latestCompletion("/wt")).toBeNull()
    expect(reads).toHaveLength(1)
  })
})
