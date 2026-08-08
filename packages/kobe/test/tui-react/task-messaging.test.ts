import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildTaskContactPrompt } from "../../src/tui/workspace/task-messaging.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

const picker = vi.hoisted(() => ({ show: vi.fn() }))

vi.mock("../../src/tui-react/component/task-message-picker-dialog", () => ({
  TaskMessagePickerDialog: picker,
}))

const { useTaskMessaging } = await import("../../src/tui-react/workspace/use-task-messaging.ts")

function task(id: string, title: string): Task {
  return {
    id: toTaskId(id),
    title,
    repo: "/repo",
    worktreePath: `/repo/${id}`,
    branch: id,
    status: "in_progress",
    archived: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  }
}

describe("cross-task message address handoff", () => {
  beforeEach(() => {
    picker.show.mockReset()
  })

  it("gives the current agent both addresses without creating a protocol", () => {
    const prompt = buildTaskContactPrompt(task("SELF01", "primary"), task("PEER02", "worker"))

    expect(prompt).toContain("your_task_id: SELF01")
    expect(prompt).toContain("peer_task_id: PEER02")
    expect(prompt).toContain("reply_to_task_id: SELF01")
    expect(prompt).toContain("kobe api send")
    expect(prompt).toContain("first message to this peer must explicitly tell the receiving agent to read")
    expect(prompt).toContain("does not create a channel, persist a relationship, or fork either chat")
    expect(prompt).not.toContain("request_id")
    expect(prompt).not.toContain("max_hops")
    expect(prompt).not.toContain("reply_policy")
  })

  it("rejects the picker when no current task is selected", () => {
    const notifyError = vi.fn()
    const messaging = useTaskMessaging({
      tasks: [],
      current: undefined,
      dialog: {} as never,
      t: (key) => key,
      sendRef: { current: vi.fn() },
      notifyError,
      notifyInfo: vi.fn(),
    })

    messaging.choosePeer()

    expect(notifyError).toHaveBeenCalledWith("taskMessaging.toast.noCurrent")
    expect(picker.show).not.toHaveBeenCalled()
  })

  it("does nothing when the picker is cancelled", async () => {
    const current = task("SELF01", "primary")
    const send = vi.fn()
    const notifyInfo = vi.fn()
    picker.show.mockResolvedValue(undefined)
    const messaging = useTaskMessaging({
      tasks: [current],
      current,
      dialog: {} as never,
      t: (key) => key,
      sendRef: { current: send },
      notifyError: vi.fn(),
      notifyInfo,
    })

    messaging.choosePeer()
    await vi.waitFor(() => expect(picker.show).toHaveBeenCalledOnce())

    expect(send).not.toHaveBeenCalled()
    expect(notifyInfo).not.toHaveBeenCalled()
  })

  it("reports a missing engine after a peer is selected", async () => {
    const current = task("SELF01", "primary")
    const peer = task("PEER02", "worker")
    const notifyError = vi.fn()
    picker.show.mockResolvedValue(peer)
    const messaging = useTaskMessaging({
      tasks: [current, peer],
      current,
      dialog: {} as never,
      t: (key) => key,
      sendRef: { current: null },
      notifyError,
      notifyInfo: vi.fn(),
    })

    messaging.choosePeer()
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith("taskMessaging.toast.noEngine"))
  })

  it("injects the selected task address into the live engine", async () => {
    const current = task("SELF01", "primary")
    const peer = task("PEER02", "worker")
    const send = vi.fn()
    const notifyInfo = vi.fn()
    picker.show.mockResolvedValue(peer)
    const messaging = useTaskMessaging({
      tasks: [current, peer],
      current,
      dialog: {} as never,
      t: (key, params) => `${key}:${params?.task ?? ""}`,
      sendRef: { current: send },
      notifyError: vi.fn(),
      notifyInfo,
    })

    messaging.choosePeer()
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())

    expect(send.mock.calls[0]?.[0]).toContain("your_task_id: SELF01")
    expect(send.mock.calls[0]?.[0]).toContain("peer_task_id: PEER02")
    expect(notifyInfo).toHaveBeenCalledWith("taskMessaging.toast.ready:worker")
  })
})
