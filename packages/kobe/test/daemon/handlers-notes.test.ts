/**
 * Field-note handler tests (`note.file` / `note.list`, docs/design/
 * dispatcher.md).
 *
 * The load-bearing bit is the ORDER: persistence happens before routing, so
 * a note filed when no dispatcher seat exists is still durable — that's the
 * whole difference between v1 (knowledge evaporates with the transcript) and
 * v2 (the next session on this repo starts with it). The other pins are the
 * degradations: a store failure must not error the agent that filed the
 * note, and neither must a missing store.
 */

import { describe, expect, it } from "vitest"
import type { Task } from "../../src/types/task.ts"
import { TASK, dispatch, fakeCtx } from "./handler-test-context.ts"

const MAIN: Task = { ...TASK, id: "m1", kind: "main", title: "repo" } as Task

describe("note.file", () => {
  it("persists the note with provenance, then relays it to the dispatcher seat", async () => {
    const { ctx, rec } = fakeCtx({
      getTask: (id: string) => (id === "t1" ? TASK : undefined),
      listTasks: () => [MAIN, TASK],
    })
    const result = await dispatch("note.file", { taskId: "t1", text: "build needs --no-sandbox" }, ctx)

    expect(result).toEqual({ ok: true, routed: true, persisted: true })
    expect(rec.noteCalls).toHaveLength(1)
    expect(rec.noteCalls[0]).toMatchObject({ method: "append", repo: "/repo" })
    expect(rec.noteCalls[0]?.note).toMatchObject({
      text: "build needs --no-sandbox",
      taskId: "t1",
      author: "demo task",
    })
    const delivered = rec.published.find((p) => p.channel === "session.deliver")
    expect(delivered?.payload).toMatchObject({ taskId: "m1", source: "note" })
    expect((delivered?.payload as { text: string }).text).toContain("build needs --no-sandbox")
  })

  it("still persists when there is no dispatcher seat — an unrouted note is no longer a loss", async () => {
    const { ctx, rec } = fakeCtx({ getTask: () => TASK, listTasks: () => [TASK] })
    const result = await dispatch("note.file", { taskId: "t1", text: "flaky auth test" }, ctx)

    expect(result).toEqual({ ok: true, routed: false, persisted: true })
    expect(rec.noteCalls).toHaveLength(1)
    expect(rec.published.filter((p) => p.channel === "session.deliver")).toHaveLength(0)
  })

  it("never routes a note back to its own author (the dispatcher noting to itself)", async () => {
    const { ctx, rec } = fakeCtx({ getTask: () => MAIN, listTasks: () => [MAIN] })
    const result = await dispatch("note.file", { taskId: "m1", text: "self note" }, ctx)

    expect(result).toMatchObject({ routed: false, persisted: true })
    expect(rec.published.filter((p) => p.channel === "session.deliver")).toHaveLength(0)
  })

  it("degrades to routing-only when the store throws — filing must never error a working agent", async () => {
    const { ctx, rec } = fakeCtx({
      getTask: (id: string) => (id === "t1" ? TASK : undefined),
      listTasks: () => [MAIN, TASK],
      noteAppendThrows: true,
    })
    const result = await dispatch("note.file", { taskId: "t1", text: "still relayed" }, ctx)

    expect(result).toEqual({ ok: true, routed: true, persisted: false })
    expect(rec.published.filter((p) => p.channel === "session.deliver")).toHaveLength(1)
  })

  it("rejects an unknown author task and files nothing", async () => {
    const { ctx, rec } = fakeCtx({ getTask: () => undefined, listTasks: () => [] })
    await expect(dispatch("note.file", { taskId: "nope", text: "x" }, ctx)).rejects.toThrow("task not found: nope")
    expect(rec.noteCalls).toHaveLength(0)
  })
})

describe("note.list", () => {
  it("returns the repo's stored notes", async () => {
    const notes = [{ at: "2026-08-08T00:00:00.000Z", text: "a gotcha", taskId: "t1", author: "demo task" }]
    const { ctx, rec } = fakeCtx({ notes })
    await expect(dispatch("note.list", { repo: "/repo" }, ctx)).resolves.toEqual({ notes })
    expect(rec.noteCalls).toEqual([{ method: "list", repo: "/repo" }])
  })

  it("requires a repo", async () => {
    const { ctx } = fakeCtx()
    await expect(dispatch("note.list", {}, ctx)).rejects.toThrow("repo is required")
  })
})
