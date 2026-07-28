import { PluginEventReducer } from "@sma1lboy/kobe-daemon/plugins/events"
import { describe, expect, it } from "vitest"

function task(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `t-${id}`,
    repo: "/repo",
    branch: `kobe/${id}`,
    worktreePath: `/wt/${id}`,
    kind: "task",
    status: "active",
    archived: false,
    pinned: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...extra,
  }
}

function snapshot(reducer: PluginEventReducer, ids: string[]) {
  return reducer.reduce({
    channel: "task.snapshot",
    payload: { tasks: ids.map((id) => task(id)) },
  } as never)
}

describe("PluginEventReducer", () => {
  it("treats the first task snapshot as baseline, then diffs", () => {
    const reducer = new PluginEventReducer(() => 42)
    expect(snapshot(reducer, ["a", "b"])).toEqual([])
    const created = snapshot(reducer, ["a", "b", "c"])
    expect(created).toEqual([
      { event: "task.created", taskId: "c", task: expect.objectContaining({ id: "c" }), at: 42 },
    ])
    const deleted = snapshot(reducer, ["a"])
    expect(deleted.map((e) => [e.event, e.taskId])).toEqual([
      ["task.deleted", "b"],
      ["task.deleted", "c"],
    ])
  })

  it("emits worktree.created only on ensureWorktree done", () => {
    const reducer = new PluginEventReducer(() => 1)
    snapshot(reducer, ["a"])
    const running = reducer.reduce({
      channel: "task.jobs",
      payload: { taskId: "a", kind: "ensureWorktree", phase: "running" },
    } as never)
    expect(running).toEqual([])
    const done = reducer.reduce({
      channel: "task.jobs",
      payload: { taskId: "a", kind: "ensureWorktree", phase: "done" },
    } as never)
    expect(done).toEqual([
      { event: "worktree.created", taskId: "a", task: expect.objectContaining({ id: "a" }), at: 1 },
    ])
  })

  it("emits agent.* only on state transitions, keyed per task+tab", () => {
    const reducer = new PluginEventReducer(() => 7)
    const feed = (taskId: string, state: string, tabId?: string) =>
      reducer.reduce({ channel: "engine-state", payload: { taskId, tabId, state, at: 0 } } as never)

    expect(feed("a", "running")).toEqual([expect.objectContaining({ event: "agent.running", taskId: "a" })])
    // Same state again → deduped.
    expect(feed("a", "running")).toEqual([])
    expect(feed("a", "turn_complete")).toEqual([expect.objectContaining({ event: "agent.turn-complete" })])
    // A different tab of the same task tracks its own state.
    expect(feed("a", "running", "tab2")).toEqual([expect.objectContaining({ event: "agent.running" })])
    expect(feed("a", "permission_needed", "tab2")).toEqual([
      expect.objectContaining({ event: "agent.permission-needed" }),
    ])
    expect(feed("b", "rate_limited")).toEqual([expect.objectContaining({ event: "agent.rate-limited", taskId: "b" })])
  })

  it("ignores unrelated channels", () => {
    const reducer = new PluginEventReducer()
    expect(reducer.reduce({ channel: "ui-prefs", payload: {} } as never)).toEqual([])
  })
})
