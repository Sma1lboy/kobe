import { describe, expect, it } from "vitest"
import {
  ATTENTION_INBOX_STATES,
  attentionInboxItemKey,
  isAttentionInboxState,
} from "../../../kobe-daemon/src/daemon/contracts.ts"

describe("attention inbox contracts", () => {
  it("keeps runtime state validation aligned with the exported state catalog", () => {
    for (const state of ATTENTION_INBOX_STATES) expect(isAttentionInboxState(state)).toBe(true)
    expect(isAttentionInboxState("running")).toBe(false)
    expect(isAttentionInboxState(null)).toBe(false)
  })

  it("uses one composite-key spelling for task and tab identity", () => {
    expect(attentionInboxItemKey({ taskId: "task-1", tabId: "tab-2" })).toBe("task-1\0tab-2")
    expect(attentionInboxItemKey({ taskId: "task-1", tabId: null })).toBe("task-1\0")
  })
})
