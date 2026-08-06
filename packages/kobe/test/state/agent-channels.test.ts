import { describe, expect, it } from "vitest"
import { availableAgentChannels, createAgentChannel, readAgentChannels } from "../../src/state/agent-channels"

describe("agent channels", () => {
  const channel = createAgentChannel({
    id: "channel-1",
    createdAt: "2026-08-06T12:00:00.000Z",
    source: { taskId: "task-a", tabId: "tab-2" },
    target: { taskId: "task-b", tabId: "tab-4" },
  })

  it("stores endpoint references without transcript data", () => {
    expect(channel).toEqual({
      id: "channel-1",
      createdAt: "2026-08-06T12:00:00.000Z",
      endpoints: [
        { taskId: "task-a", tabId: "tab-2" },
        { taskId: "task-b", tabId: "tab-4" },
      ],
    })
    expect(channel).not.toHaveProperty("messages")
  })

  it("validates records independently and de-duplicates ids", () => {
    expect(readAgentChannels([channel, channel, { id: "bad", createdAt: 1, endpoints: [] }, null])).toEqual([channel])
    expect(readAgentChannels({ channels: [channel] })).toEqual([])
  })

  it("rejects a same-task pair", () => {
    expect(() =>
      createAgentChannel({
        id: "bad",
        createdAt: "now",
        source: { taskId: "task-a", tabId: "tab-1" },
        target: { taskId: "task-a", tabId: "tab-2" },
      }),
    ).toThrow("two tasks")
  })

  it("hides channels whose endpoint task no longer exists", () => {
    expect(availableAgentChannels([channel], new Set(["task-a", "task-b"]))).toEqual([channel])
    expect(availableAgentChannels([channel], new Set(["task-a"]))).toEqual([])
  })
})
