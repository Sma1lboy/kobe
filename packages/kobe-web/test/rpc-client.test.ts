import { describe, expect, it, vi } from "vitest"
import { ApiError } from "../src/lib/api-client.ts"
import { createHttpDaemonRpcClient } from "../src/lib/rpc-client.ts"

describe("createHttpDaemonRpcClient", () => {
  it("wraps daemon RPC requests in the browser /api/rpc envelope", async () => {
    const post = vi.fn(async () => ({ result: { tasks: [{ id: "t1" }] } }))
    const client = createHttpDaemonRpcClient({ post })

    await expect(client.request("task.list")).resolves.toEqual({ tasks: [{ id: "t1" }] })
    expect(post).toHaveBeenCalledWith(
      "/api/rpc",
      { name: "task.list", payload: undefined },
      { label: "rpc task.list" },
    )
  })

  it("lets ApiError preserve daemon error names for callers", async () => {
    const post = vi.fn(async () => {
      throw new ApiError({
        url: "/api/rpc",
        status: 500,
        label: "rpc task.status",
        detail: "illegal transition",
        name: "IllegalTransitionError",
      })
    })
    const client = createHttpDaemonRpcClient({ post })

    await expect(client.request("task.status", { taskId: "t1", status: "done" })).rejects.toMatchObject({
      name: "IllegalTransitionError",
      detail: "illegal transition",
    })
  })
})
