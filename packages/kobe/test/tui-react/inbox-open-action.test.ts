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

// Opening RESOLVES the episode (queue-drain model, owner 2026-07-16): both
// the available and the unavailable path dismiss it from the daemon store;
// only navigation differs (an unavailable target can't be jumped to).
describe("requestInboxItemOpen", () => {
  it("resolves an available item and allows navigation", () => {
    const rpc = { dismissAttention: vi.fn().mockResolvedValue(undefined) }

    expect(requestInboxItemOpen(item, true, rpc, vi.fn())).toBe(true)
    expect(rpc.dismissAttention).toHaveBeenCalledWith("task-1", "tab-2", 123)
  })

  it("resolves an unavailable item without navigating", () => {
    const rpc = { dismissAttention: vi.fn().mockResolvedValue(undefined) }

    expect(requestInboxItemOpen(item, false, rpc, vi.fn())).toBe(false)
    expect(rpc.dismissAttention).toHaveBeenCalledWith("task-1", "tab-2", 123)
  })
})
