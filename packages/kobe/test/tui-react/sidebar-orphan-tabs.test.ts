/**
 * Orphan-tab backstop: a task with a LIVE pty session but no persisted tab
 * snapshot must still render tab rows. Before this, a headless-started
 * session (`kobe api add --prompt`, `kobe api send`, a routine firing) ran a
 * real engine while the sidebar showed its worktree with nothing under it —
 * and headless start is how agent-driven work enters kobe.
 *
 * The rule these pin: the backstop only ever FILLS HOLES. A task the
 * snapshot answered for keeps its snapshot projection, which carries titles,
 * ordinals and kinds a bare session key cannot.
 */

import { describe, expect, it } from "vitest"
import { orphanTabsByTask } from "../../src/tui-react/panes/sidebar/orphan-tabs"

const session = (key: string, over: { alive?: boolean; title?: string | null } = {}) => ({ key, ...over })

describe("orphanTabsByTask", () => {
  it("derives a tab row for a live session whose task has no snapshot", () => {
    const map = orphanTabsByTask([session("t1::tab-1")], new Set())
    expect(map.get("t1")).toEqual([{ id: "tab-1", label: "tab-1", active: true, engine: true }])
  })

  it("prefers the live process title when the host observed one", () => {
    const map = orphanTabsByTask([session("t1::tab-1", { title: "  claude — building  " })], new Set())
    expect(map.get("t1")?.[0]?.label).toBe("claude — building")
  })

  it("never overrides a task the snapshot already answered for", () => {
    const map = orphanTabsByTask([session("t1::tab-1")], new Set(["t1"]))
    expect(map.has("t1")).toBe(false)
  })

  it("ignores dead sessions and keys with no tab part", () => {
    const map = orphanTabsByTask([session("t1::tab-1", { alive: false }), session("bare-task-id")], new Set())
    expect(map.size).toBe(0)
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
