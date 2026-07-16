import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import { describe, expect, it } from "vitest"
import { fakeCtx } from "./handler-test-context.ts"

function dispatch(name: DaemonRequestName, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}

describe("attention.dismiss handler", () => {
  it("marks the exact opened episode read", async () => {
    const { ctx, rec } = fakeCtx()
    await expect(dispatch("attention.read", { taskId: "t1", tabId: "tab-2", at: 42 }, ctx)).resolves.toEqual({
      updated: true,
    })
    expect(rec.inboxRead).toEqual([{ taskId: "t1", tabId: "tab-2", at: 42 }])
  })

  it("rejects a malformed episode timestamp", async () => {
    const { ctx } = fakeCtx()
    await expect(dispatch("attention.read", { taskId: "t1", at: "old" }, ctx)).rejects.toThrow(
      "at must be a finite number",
    )
  })

  it("deletes exactly one task+tab episode", async () => {
    const { ctx, rec } = fakeCtx()
    await expect(dispatch("attention.dismiss", { taskId: "t1", tabId: "tab-2", at: 42 }, ctx)).resolves.toEqual({
      deleted: true,
    })
    expect(rec.inboxDeleted).toEqual([{ taskId: "t1", tabId: "tab-2", at: 42 }])
  })

  it("supports a legacy task-level episode", async () => {
    const { ctx, rec } = fakeCtx()
    await dispatch("attention.dismiss", { taskId: "t1" }, ctx)
    expect(rec.inboxDeleted).toEqual([{ taskId: "t1", tabId: null }])
  })

  it("rejects a malformed optional dismiss timestamp", async () => {
    const { ctx } = fakeCtx()
    await expect(dispatch("attention.dismiss", { taskId: "t1", at: "old" }, ctx)).rejects.toThrow(
      "at must be a finite number",
    )
  })

  it("records normalized engine events with their chat-tab identity", async () => {
    const { ctx, rec } = fakeCtx()
    await dispatch("engine.reportEvent", { taskId: "t1", tabId: "tab-3", kind: "awaiting-input" }, ctx)
    expect(rec.inboxRecords).toEqual([{ taskId: "t1", kind: "awaiting-input", detail: undefined, tabId: "tab-3" }])
  })

  it("keeps cwd-matched external engine events out of the Inbox", async () => {
    const { ctx, rec } = fakeCtx({ listTasks: () => [{ id: "t1", worktreePath: "/repo" }] })
    await dispatch("engine.reportEvent", { cwd: "/repo/src", kind: "turn-complete" }, ctx)

    expect(rec.reported).toEqual([{ taskId: "t1", kind: "turn-complete", detail: undefined }])
    expect(rec.inboxRecords).toEqual([])
  })

  it("rejects an orphaned tabId without exact task identity", async () => {
    const { ctx, rec } = fakeCtx({ listTasks: () => [{ id: "t1", worktreePath: "/repo" }] })
    await dispatch("engine.reportEvent", { cwd: "/repo/src", tabId: "tab-9", kind: "turn-complete" }, ctx)

    expect(rec.reported).toEqual([{ taskId: "t1", kind: "turn-complete", detail: undefined }])
    expect(rec.inboxRecords).toEqual([])
  })

  it("requires a tabId before recording an explicitly attributed event", async () => {
    const { ctx, rec } = fakeCtx()
    await dispatch("engine.reportEvent", { taskId: "t1", kind: "turn-complete" }, ctx)

    expect(rec.reported).toEqual([{ taskId: "t1", kind: "turn-complete", detail: undefined }])
    expect(rec.inboxRecords).toEqual([])
  })

  it("does not drop the engine event when Inbox persistence fails", async () => {
    const { ctx, rec } = fakeCtx()
    ctx.inbox.record = async () => {
      throw new Error("disk full")
    }

    await expect(
      dispatch("engine.reportEvent", { taskId: "t1", tabId: "tab-3", kind: "turn-complete" }, ctx),
    ).resolves.toEqual({})
    expect(rec.reported).toEqual([{ taskId: "t1", kind: "turn-complete", detail: undefined }])
  })
})
