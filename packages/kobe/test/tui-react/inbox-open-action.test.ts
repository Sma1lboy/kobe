import { describe, expect, it, vi } from "vitest"
import type { AttentionInboxItem } from "../../src/client/remote-orchestrator"
import { requestInboxItemOpen } from "../../src/tui-react/workspace/inbox-open-action"

const item: AttentionInboxItem = {
  taskId: "task-1",
  tabId: "tab-2",
  state: "error",
  unread: true,
  at: 123,
}

describe("requestInboxItemOpen", () => {
  it("marks an available item read and allows navigation", () => {
    const rpc = { markAttentionRead: vi.fn().mockResolvedValue(undefined), dismissAttention: vi.fn() }

    expect(requestInboxItemOpen(item, true, rpc, vi.fn())).toBe(true)
    expect(rpc.markAttentionRead).toHaveBeenCalledWith("task-1", "tab-2", 123)
    expect(rpc.dismissAttention).not.toHaveBeenCalled()
  })

  it("dismisses an unavailable item without navigating", () => {
    const rpc = { markAttentionRead: vi.fn(), dismissAttention: vi.fn().mockResolvedValue(undefined) }

    expect(requestInboxItemOpen(item, false, rpc, vi.fn())).toBe(false)
    expect(rpc.dismissAttention).toHaveBeenCalledWith("task-1", "tab-2", 123)
    expect(rpc.markAttentionRead).not.toHaveBeenCalled()
  })
})
