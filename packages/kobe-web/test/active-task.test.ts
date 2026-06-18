import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../src/lib/store.ts", () => ({ rpc: vi.fn() }))

import {
  setActiveTask,
  setActiveTaskBestEffort,
} from "../src/lib/active-task.ts"
import { rpc } from "../src/lib/store.ts"

describe("active-task", () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset()
  })

  it("uses one daemon RPC contract for setting the active task", async () => {
    vi.mocked(rpc).mockResolvedValue(undefined)

    await setActiveTask("task-1")
    await setActiveTask(null)

    expect(rpc).toHaveBeenNthCalledWith(1, "task.setActive", {
      taskId: "task-1",
    })
    expect(rpc).toHaveBeenNthCalledWith(2, "task.setActive", {
      taskId: null,
    })
  })

  it("keeps best-effort callers fire-and-forget while exposing the error hook", async () => {
    const err = new Error("daemon down")
    const onError = vi.fn()
    vi.mocked(rpc).mockRejectedValue(err)

    setActiveTaskBestEffort("task-2", onError)
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(err)
  })
})
