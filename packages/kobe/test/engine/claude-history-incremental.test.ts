import { describe, expect, it } from "vitest"
import type { HistoryDeps } from "../../src/engine/claude-code-local/history.ts"
import { readHistory } from "../../src/engine/claude-code-local/history.ts"

/**
 * Why these tests matter: the chat pane polls `readHistory` every ~2.5s and
 * Solid's `<For>` keys rows by object reference. If each poll returns fresh
 * Message objects for unchanged records, every rendered row's native subtree
 * is destroyed and recreated per tick. The append-aware cache must therefore
 * (a) return the SAME object refs for already-seen messages when the file only
 * appended, and (b) still produce output identical to a full re-parse —
 * including on rewrite/truncation (compaction, branch rewrites), where it must
 * fall back rather than serve stale prefix state.
 */

function record(role: "user" | "assistant", text: string, ts: string): string {
  return JSON.stringify({ type: role, message: { role, content: text }, timestamp: ts, sessionId: "sid" })
}

/**
 * Fake FS where the "file" contents are mutable between reads. Each test uses
 * a unique projectsDir so the module-level cache (keyed by file path) never
 * bleeds state across tests.
 */
function fakeDeps(name: string, sessionId: string): { deps: HistoryDeps; set: (raw: string) => void } {
  let raw = ""
  const root = `/fake-${name}`
  const deps: HistoryDeps = {
    projectsDir: () => root,
    readdir: async () => ["proj"],
    readFile: async (p) => {
      if (p !== `${root}/proj/${sessionId}.jsonl`) throw new Error("ENOENT")
      return raw
    },
    pathExists: async () => true,
  }
  return {
    deps,
    set: (next) => {
      raw = next
    },
  }
}

describe("readHistory append-aware cache", () => {
  it("append: already-seen messages keep object identity; new ones are appended", async () => {
    const { deps, set } = fakeDeps("append", "s1")
    const l1 = record("user", "first", "2026-01-01T00:00:01.000Z")
    const l2 = record("assistant", "second", "2026-01-01T00:00:02.000Z")
    set(`${l1}\n${l2}\n`)

    const first = await readHistory("s1", deps)
    expect(first.map((m) => m.blocks)).toEqual([[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]])

    const l3 = record("user", "third", "2026-01-01T00:00:03.000Z")
    set(`${l1}\n${l2}\n${l3}\n`)
    const second = await readHistory("s1", deps)

    expect(second).toHaveLength(3)
    // Identity-stable prefix: same refs, not just deep-equal copies.
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
    expect(second[2]?.blocks).toEqual([{ type: "text", text: "third" }])
  })

  it("append with an out-of-order timestamp still sorts like a full parse", async () => {
    const { deps, set } = fakeDeps("resort", "s2")
    const late = record("assistant", "late", "2026-01-01T00:00:09.000Z")
    set(`${late}\n`)
    const first = await readHistory("s2", deps)

    // A resumed-branch record can land in the file AFTER records that carry
    // an earlier timestamp; output must stay timestamp-sorted.
    const early = record("user", "early", "2026-01-01T00:00:01.000Z")
    set(`${late}\n${early}\n`)
    const second = await readHistory("s2", deps)

    expect(second.map((m) => m.blocks[0])).toEqual([
      { type: "text", text: "early" },
      { type: "text", text: "late" },
    ])
    expect(second[1]).toBe(first[0])
  })

  it("rewrite: a changed prefix falls back to a full re-parse", async () => {
    const { deps, set } = fakeDeps("rewrite", "s3")
    const l1 = record("user", "original", "2026-01-01T00:00:01.000Z")
    set(`${l1}\n`)
    await readHistory("s3", deps)

    // Same length or longer doesn't matter — the prefix hash must mismatch.
    const rewritten = record("user", "compacted summary instead", "2026-01-01T00:00:01.000Z")
    const extra = record("assistant", "after rewrite", "2026-01-01T00:00:02.000Z")
    set(`${rewritten}\n${extra}\n`)

    const out = await readHistory("s3", deps)
    expect(out.map((m) => m.blocks[0])).toEqual([
      { type: "text", text: "compacted summary instead" },
      { type: "text", text: "after rewrite" },
    ])
  })

  it("truncation: a shorter file falls back to a full re-parse", async () => {
    const { deps, set } = fakeDeps("truncate", "s4")
    const l1 = record("user", "keep", "2026-01-01T00:00:01.000Z")
    const l2 = record("assistant", "dropped by truncation", "2026-01-01T00:00:02.000Z")
    set(`${l1}\n${l2}\n`)
    const first = await readHistory("s4", deps)
    expect(first).toHaveLength(2)

    set(`${l1}\n`)
    const second = await readHistory("s4", deps)
    expect(second).toHaveLength(1)
    expect(second[0]?.blocks).toEqual([{ type: "text", text: "keep" }])

    // And the cache is REPLACED by the truncated state: appending after the
    // truncation parses from the new baseline, not the stale long prefix.
    const l3 = record("assistant", "fresh reply", "2026-01-01T00:00:03.000Z")
    set(`${l1}\n${l3}\n`)
    const third = await readHistory("s4", deps)
    expect(third.map((m) => m.blocks[0])).toEqual([
      { type: "text", text: "keep" },
      { type: "text", text: "fresh reply" },
    ])
    expect(third[0]).toBe(second[0])
  })

  it("a partially flushed trailing line is never split by the cache boundary", async () => {
    const { deps, set } = fakeDeps("partial", "s5")
    const l1 = record("user", "done line", "2026-01-01T00:00:01.000Z")
    const l2 = record("assistant", "mid-flush", "2026-01-01T00:00:02.000Z")
    // Snapshot taken mid-write: l2 has no trailing newline and is only half
    // on disk. A naive byte-offset cache would anchor here and later parse
    // only the REST of l2 — losing the message vs a full parse.
    set(`${l1}\n${l2.slice(0, 20)}`)
    const first = await readHistory("s5", deps)
    expect(first).toHaveLength(1)

    set(`${l1}\n${l2}\n`)
    const second = await readHistory("s5", deps)
    expect(second.map((m) => m.blocks[0])).toEqual([
      { type: "text", text: "done line" },
      { type: "text", text: "mid-flush" },
    ])
    expect(second[0]).toBe(first[0])
  })

  it("repeat read with no change returns the same message refs", async () => {
    const { deps, set } = fakeDeps("stable", "s6")
    set(`${record("user", "hello", "2026-01-01T00:00:01.000Z")}\n`)
    const a = await readHistory("s6", deps)
    const b = await readHistory("s6", deps)
    expect(b[0]).toBe(a[0])
  })
})
