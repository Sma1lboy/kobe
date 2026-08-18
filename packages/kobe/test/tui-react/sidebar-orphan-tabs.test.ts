/**
 * Orphan-tab backstop: any LIVE pty session the persisted snapshots do not
 * answer for must render as an explicit unregistered tab row. Two shapes:
 *
 *   - a task with NO snapshot at all (headless start before the CLI wrote
 *     snapshots) — the original hole-filling case;
 *   - a task WITH a snapshot that is missing the session's tab (issue #20:
 *     the canonical-spawn fallback ran a live engine for 1h44m while the
 *     sidebar rendered only the snapshot's tab-2 — a writable engine the UI
 *     never showed).
 *
 * The rule these pin: reconciliation is TAB-granular. A registered tab keeps
 * its snapshot projection (titles, ordinals, kinds); an unregistered live
 * session becomes a ⚠ row instead of vanishing.
 */

import { describe, expect, it } from "vitest"
import { orphanTabsByTask } from "../../src/tui-react/panes/sidebar/orphan-tabs"

const session = (key: string, over: { alive?: boolean; title?: string | null } = {}) => ({ key, ...over })

describe("orphanTabsByTask", () => {
  it("derives a tab row for a live session whose task has no snapshot", () => {
    const map = orphanTabsByTask([session("t1::tab-1")], new Set())
    expect(map.get("t1")).toEqual([{ id: "tab-1", label: "⚠ tab-1", active: true, engine: true }])
  })

  it("prefers the live process title when the host observed one", () => {
    const map = orphanTabsByTask([session("t1::tab-1", { title: "  claude — building  " })], new Set())
    expect(map.get("t1")?.[0]?.label).toBe("⚠ claude — building")
  })

  it("surfaces a live session missing from its task's snapshot — the issue-#20 invisible engine", () => {
    // Snapshot answered for tab-2 only; tab-1 is alive on the host.
    const map = orphanTabsByTask([session("t1::tab-1"), session("t1::tab-2")], new Set(["t1::tab-2"]))
    expect(map.get("t1")?.map((t) => t.id)).toEqual(["tab-1"])
  })

  it("skips a tab the snapshot already answered for", () => {
    const map = orphanTabsByTask([session("t1::tab-1")], new Set(["t1::tab-1"]))
    expect(map.has("t1")).toBe(false)
  })

  it("ignores dead sessions and keys with no tab part", () => {
    const map = orphanTabsByTask([session("t1::tab-1", { alive: false }), session("bare-task-id")], new Set())
    expect(map.size).toBe(0)
  })

  it("collapses a split's shell leaf into its tab instead of minting a bogus row", () => {
    expect(orphanTabsByTask([session("t1::tab-2::leaf-1")], new Set(["t1::tab-2"])).size).toBe(0)
    const map = orphanTabsByTask([session("t1::tab-2"), session("t1::tab-2::leaf-1")], new Set())
    expect(map.get("t1")?.map((t) => t.id)).toEqual(["tab-2"])
  })

  it("marks only the first tab of a task active", () => {
    const map = orphanTabsByTask([session("t1::tab-1"), session("t1::tab-2")], new Set())
    expect(map.get("t1")?.map((t) => t.active)).toEqual([true, false])
  })

  it("groups sessions by their task", () => {
    const map = orphanTabsByTask([session("t1::tab-1"), session("t2::tab-1")], new Set())
    expect([...map.keys()].sort()).toEqual(["t1", "t2"])
  })
})
