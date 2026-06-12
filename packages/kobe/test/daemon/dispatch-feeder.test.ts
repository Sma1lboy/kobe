import { DispatchFeeder, RADAR_ALL_CLEAR, formatRadarDigest } from "@sma1lboy/kobe-daemon/daemon/dispatch-feeder"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { ConflictPair, SessionDeliverPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it } from "vitest"
import type { Task } from "../../src/types/task.ts"

/**
 * Dispatch feeder (docs/design/dispatcher.md). Load-bearing rules: radar
 * pairs regroup per repo and feed THAT repo's main task; publish-on-change
 * only (a repeated radar publish feeds nothing); a repo whose pairs vanish
 * gets exactly one all-clear; the experimental switch gates everything; a
 * repo without a main task is silently skipped.
 */

const task = (over: Partial<Omit<Task, "id">> & { id?: string }): Task =>
  ({
    id: "t",
    title: "demo",
    repo: "/repo",
    branch: "kobe/demo",
    worktreePath: "/repo/.kobe/worktrees/demo",
    kind: "task",
    status: "in_progress",
    archived: false,
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T00:00:00Z",
    ...over,
  }) as Task

const pair = (a: string, b: string, level: "overlap" | "conflict" = "conflict"): ConflictPair => ({
  a,
  b,
  files: ["src/auth.ts"],
  level,
})

function make(opts: { tasks: Task[]; enabled?: boolean }) {
  const bus = new DaemonEventBus()
  const delivered: SessionDeliverPayload[] = []
  bus.onPublish((event) => {
    if (event.channel === "session.deliver") delivered.push(event.payload as SessionDeliverPayload)
  })
  const feeder = new DispatchFeeder({ listTasks: () => opts.tasks }, bus, {
    enabled: () => opts.enabled !== false,
    now: () => 1_000,
  })
  feeder.start()
  return { bus, delivered, feeder }
}

const FLEET = [
  task({ id: "main1", kind: "main", repo: "/repo", worktreePath: "/repo" }),
  task({ id: "a", repo: "/repo", title: "auth work" }),
  task({ id: "b", repo: "/repo", title: "db work" }),
  task({ id: "main2", kind: "main", repo: "/other", worktreePath: "/other" }),
  task({ id: "x", repo: "/other" }),
  task({ id: "y", repo: "/other" }),
]

describe("DispatchFeeder", () => {
  it("feeds the repo's main task a digest naming the pair, ids included", () => {
    const { bus, delivered } = make({ tasks: FLEET })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.taskId).toBe("main1")
    expect(delivered[0]?.source).toBe("radar")
    expect(delivered[0]?.text).toContain("[KOBE CONFLICT RADAR]")
    expect(delivered[0]?.text).toContain('CONFLICT: "auth work" (task a)')
    expect(delivered[0]?.text).toContain("(task b)")
    expect(delivered[0]?.text).toContain("src/auth.ts")
  })

  it("regroups per repo — each repo's main gets only its own pairs", () => {
    const { bus, delivered } = make({ tasks: FLEET })
    bus.publish("task.conflicts", { pairs: [pair("a", "b"), pair("x", "y", "overlap")] })
    expect(delivered.map((d) => d.taskId).sort()).toEqual(["main1", "main2"])
    const other = delivered.find((d) => d.taskId === "main2")
    expect(other?.text).toContain("overlap:")
    expect(other?.text).not.toContain("auth work")
  })

  it("publish-on-change: an identical radar publish feeds nothing", () => {
    const { bus, delivered } = make({ tasks: FLEET })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    expect(delivered).toHaveLength(1)
  })

  it("a repo whose pairs vanish gets exactly one all-clear", () => {
    const { bus, delivered } = make({ tasks: FLEET })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    bus.publish("task.conflicts", { pairs: [] })
    bus.publish("task.conflicts", { pairs: [] })
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.text).toBe(RADAR_ALL_CLEAR)
    // A repo that never had pairs gets no all-clear noise.
    expect(delivered.filter((d) => d.taskId === "main2")).toHaveLength(0)
  })

  it("the switch gates everything", () => {
    const { bus, delivered } = make({ tasks: FLEET, enabled: false })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    expect(delivered).toHaveLength(0)
  })

  it("a repo without a main task is skipped silently", () => {
    const noMain = FLEET.filter((t) => t.id !== "main1")
    const { bus, delivered } = make({ tasks: noMain })
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    expect(delivered).toHaveLength(0)
  })

  it("stop() detaches — a later radar publish feeds nothing", () => {
    const { bus, delivered, feeder } = make({ tasks: FLEET })
    feeder.stop()
    bus.publish("task.conflicts", { pairs: [pair("a", "b")] })
    expect(delivered).toHaveLength(0)
  })
})

describe("formatRadarDigest", () => {
  it("falls back to branch, then id, for unnamed tasks", () => {
    const tasks = new Map<string, Task>([["a", task({ id: "a", title: "", branch: "kobe/x" })]])
    const text = formatRadarDigest([pair("a", "ghost")], tasks)
    expect(text).toContain('"kobe/x" (task a)')
    expect(text).toContain('"ghost" (task ghost)')
  })
})
