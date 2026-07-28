/**
 * Story-drawer EVENTS feed view model (component/issue-events-core.ts).
 *
 * The daemon's ring hands over loosely-typed `detail` records, so what can
 * silently go wrong is pinned here: which fragment wins per kind, a detail
 * whose shape isn't what the kind implies, and the tail-of-the-ring +
 * newest-last ordering the section renders.
 */

import { describe, expect, it } from "vitest"
import type { RecentTaskEvent } from "../../src/client/remote-orchestrator.ts"
import { detailFragment, eventRows } from "../../src/tui-react/component/issue-events-core.ts"

const NOW = Date.parse("2026-07-28T12:00:00.000Z")
const minutesAgo = (n: number) => NOW - n * 60_000

describe("detailFragment", () => {
  it("picks tool name, compact trigger, subagent type, then note", () => {
    const at = NOW
    expect(detailFragment({ kind: "tool-post", at, detail: { tool: { name: "Bash", id: "t1" } } })).toBe("Bash")
    expect(detailFragment({ kind: "pre-compact", at, detail: { compact: { trigger: "auto" } } })).toBe("auto")
    expect(detailFragment({ kind: "subagent-start", at, detail: { subagent: { type: "Explore" } } })).toBe("Explore")
    expect(detailFragment({ kind: "turn-failed", at, detail: { note: "rate limited" } })).toBe("rate limited")
  })

  it("yields nothing for a detail-less or mis-shaped event", () => {
    expect(detailFragment({ kind: "turn-start", at: NOW })).toBe("")
    expect(detailFragment({ kind: "turn-start", at: NOW, detail: {} })).toBe("")
    expect(detailFragment({ kind: "tool-post", at: NOW, detail: { tool: "Bash" } })).toBe("")
  })

  it("clips a long fragment instead of wrapping the row", () => {
    const fragment = detailFragment({ kind: "turn-failed", at: NOW, detail: { note: "x".repeat(80) } })
    expect(fragment.length).toBeLessThanOrEqual(40)
    expect(fragment.endsWith("…")).toBe(true)
  })
})

describe("eventRows", () => {
  const events: readonly RecentTaskEvent[] = [
    { kind: "turn-start", at: minutesAgo(9), vendor: "claude" },
    { kind: "tool-post", at: minutesAgo(5), vendor: "claude", detail: { tool: { name: "Edit" } } },
    { kind: "pre-compact", at: minutesAgo(2), detail: { compact: { trigger: "manual" } } },
  ]

  it("renders age, raw kind, and the detail · vendor tail, newest first", () => {
    expect(eventRows(events, NOW)).toEqual([
      { key: `${minutesAgo(2)}:0`, age: "2m", kind: "pre-compact", tail: "manual" },
      { key: `${minutesAgo(5)}:1`, age: "5m", kind: "tool-post", tail: "Edit · claude" },
      { key: `${minutesAgo(9)}:2`, age: "9m", kind: "turn-start", tail: "claude" },
    ])
  })

  it("keeps the NEWEST events when the ring overflows the limit", () => {
    const rows = eventRows(events, NOW, 2)
    expect(rows.map((row) => row.kind)).toEqual(["pre-compact", "tool-post"])
  })

  it("has nothing to show for an empty ring", () => {
    expect(eventRows([], NOW)).toEqual([])
  })
})
