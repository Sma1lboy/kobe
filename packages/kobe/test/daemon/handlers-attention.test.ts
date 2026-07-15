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
  it("deletes exactly one task+tab episode", async () => {
    const { ctx, rec } = fakeCtx()
    await expect(dispatch("attention.dismiss", { taskId: "t1", tabId: "tab-2" }, ctx)).resolves.toEqual({
      deleted: true,
    })
    expect(rec.inboxDeleted).toEqual([{ taskId: "t1", tabId: "tab-2" }])
  })

  it("supports a legacy task-level episode", async () => {
    const { ctx, rec } = fakeCtx()
    await dispatch("attention.dismiss", { taskId: "t1" }, ctx)
    expect(rec.inboxDeleted).toEqual([{ taskId: "t1", tabId: null }])
  })

  it("records normalized engine events with their chat-tab identity", async () => {
    const { ctx, rec } = fakeCtx()
    await dispatch("engine.reportEvent", { taskId: "t1", tabId: "tab-3", kind: "awaiting-input" }, ctx)
    expect(rec.inboxRecords).toEqual([{ taskId: "t1", kind: "awaiting-input", detail: undefined, tabId: "tab-3" }])
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
