/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, it } from "bun:test"
import { type Dispatch, type SetStateAction, useState } from "react"
import type { AttentionInboxItem, TaskEngineState } from "../../src/client/remote-orchestrator"
import type { KVContext } from "../../src/tui-react/context/kv"
import type { NotificationsContext } from "../../src/tui-react/context/notifications"
import { tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { useAttention } from "../../src/tui-react/workspace/use-attention"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

const task = (id: string, title: string, archived = false): Task => ({
  id: toTaskId(id),
  title,
  repo: `/tmp/${id}`,
  branch: id,
  worktreePath: `/tmp/${id}`,
  status: "in_progress",
  archived,
  createdAt: "2026-07-15T00:00:00.000Z",
  updatedAt: "2026-07-15T00:00:00.000Z",
})

const inboxItem = (taskId: string, tabId: string | null, unread = true): AttentionInboxItem =>
  ({ taskId, tabId, state: "turn_complete", unread, at: 10 }) as AttentionInboxItem

const kv = (crossTaskEnabled = true): KVContext =>
  ({
    store: {},
    get: (key: string, fallback?: unknown) => (key === "notifications.crossTask.enabled" ? crossTaskEnabled : fallback),
  }) as KVContext

function notifications(notify: NotificationsContext["notify"]): NotificationsContext {
  return { notify } as NotificationsContext
}

afterEach(() => tabsByTask.clear())

describe("useAttention", () => {
  it("jumps from the current chat tab to the next pending live task", async () => {
    const tasks = [task("task-a", "Alpha"), task("task-b", "Beta"), task("task-c", "Archived", true)]
    const opened: AttentionInboxItem[] = []
    let jump: (() => void) | undefined
    tabsByTask.set("task-a", {
      tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }],
      activeId: "tab-1",
      nextOrdinal: 2,
    })

    function Probe() {
      jump = useAttention({
        tasks,
        engineState: new Map(),
        inboxItems: [inboxItem("task-a", "tab-1"), inboxItem("task-b", null), inboxItem("task-c", null)],
        selectedId: "task-a",
        kv: kv(),
        notif: notifications(() => {}),
        openAttention: (item) => opened.push(item),
        noTasksMessage: "No pending attention",
      }).jumpToNextAttention
      return <text>ready</text>
    }

    await renderComponent(<Probe />)
    act(() => jump?.())

    expect(opened.map((item) => item.taskId)).toEqual(["task-b"])
  })

  it("shows the fallback toast when no pending episode is available", async () => {
    const notices: Parameters<NotificationsContext["notify"]>[0][] = []
    let jump: (() => void) | undefined

    function Probe() {
      jump = useAttention({
        tasks: [task("task-a", "Alpha")],
        engineState: new Map(),
        // Queue-drain model: an empty Inbox is the only "nothing to visit"
        // state (opened episodes are removed, not retained as read).
        inboxItems: [],
        selectedId: "task-a",
        kv: kv(),
        notif: notifications((notice) => notices.push(notice)),
        openAttention: () => {},
        noTasksMessage: "No pending attention",
      }).jumpToNextAttention
      return <text>ready</text>
    }

    await renderComponent(<Probe />)
    act(() => jump?.())

    expect(notices).toEqual([{ kind: "done", taskId: "task-a", tabId: "", title: "No pending attention" }])
  })

  it("notifies only on a non-selected task's rising attention edge", async () => {
    const tasks = [task("task-a", "Alpha"), task("task-b", "Beta")]
    const notices: Parameters<NotificationsContext["notify"]>[0][] = []
    let setEngineState: Dispatch<SetStateAction<ReadonlyMap<string, TaskEngineState>>> | undefined

    function Probe() {
      const [engineState, setState] = useState<ReadonlyMap<string, TaskEngineState>>(
        new Map([["task-b", { state: "idle", at: 1 }]]),
      )
      setEngineState = setState
      useAttention({
        tasks,
        engineState,
        inboxItems: [],
        selectedId: "task-a",
        kv: kv(),
        notif: notifications((notice) => notices.push(notice)),
        openAttention: () => {},
        noTasksMessage: "No pending attention",
      })
      return <text>ready</text>
    }

    const { rerender } = await renderComponent(<Probe />)
    expect(notices).toEqual([])

    act(() => setEngineState?.(new Map([["task-b", { state: "permission_needed", at: 2 }]])))
    await rerender()

    expect(notices).toEqual([{ kind: "needs_input", taskId: "task-b", tabId: "", title: "Beta", body: "task-b" }])
  })

  it("honors the disabled cross-task notification preference", async () => {
    const notices: Parameters<NotificationsContext["notify"]>[0][] = []
    let setEngineState: Dispatch<SetStateAction<ReadonlyMap<string, TaskEngineState>>> | undefined

    function Probe() {
      const [engineState, setState] = useState<ReadonlyMap<string, TaskEngineState>>(
        new Map([["task-b", { state: "idle", at: 1 }]]),
      )
      setEngineState = setState
      useAttention({
        tasks: [task("task-a", "Alpha"), task("task-b", "Beta")],
        engineState,
        inboxItems: [],
        selectedId: "task-a",
        kv: kv(false),
        notif: notifications((notice) => notices.push(notice)),
        openAttention: () => {},
        noTasksMessage: "No pending attention",
      })
      return <text>ready</text>
    }

    const { rerender } = await renderComponent(<Probe />)
    act(() => setEngineState?.(new Map([["task-b", { state: "error", at: 2 }]])))
    await rerender()

    expect(notices).toEqual([])
  })
})
