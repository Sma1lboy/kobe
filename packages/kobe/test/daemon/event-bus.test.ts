import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { describe, expect, it } from "vitest"

describe("DaemonEventBus", () => {
  it("fans a publish out to every registered sink", () => {
    const bus = new DaemonEventBus()
    const a: unknown[] = []
    const b: unknown[] = []
    bus.onPublish((e) => a.push(e))
    bus.onPublish((e) => b.push(e))
    bus.publish("active-task", { taskId: "t1" })
    expect(a).toEqual([{ channel: "active-task", payload: { taskId: "t1" } }])
    expect(b).toEqual([{ channel: "active-task", payload: { taskId: "t1" } }])
  })

  it("caches the LAST value per channel for late-subscriber replay", () => {
    const bus = new DaemonEventBus()
    bus.publish("active-task", { taskId: "t1" })
    bus.publish("active-task", { taskId: "t2" })
    bus.publish("task.snapshot", { tasks: [] })
    const snap = bus.snapshot()
    expect(snap).toContainEqual({ channel: "active-task", payload: { taskId: "t2" } })
    expect(snap).toContainEqual({ channel: "task.snapshot", payload: { tasks: [] } })
    expect(snap.filter((e) => e.channel === "active-task")).toHaveLength(1)
  })

  it("has an empty snapshot before anything is published (cold cache)", () => {
    expect(new DaemonEventBus().snapshot()).toEqual([])
  })

  it("stops delivering to a sink after it unsubscribes", () => {
    const bus = new DaemonEventBus()
    const got: unknown[] = []
    const off = bus.onPublish((e) => got.push(e))
    bus.publish("active-task", { taskId: "t1" })
    off()
    bus.publish("active-task", { taskId: "t2" })
    expect(got).toEqual([{ channel: "active-task", payload: { taskId: "t1" } }])
  })
})
