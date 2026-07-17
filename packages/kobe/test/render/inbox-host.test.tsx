/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import type { AttentionInboxItem, RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { createStateCell } from "../../src/lib/external-store"
import { useKV } from "../../src/tui-react/context/kv"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { tabsByTask, takeTabActivation } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { useInboxHost } from "../../src/tui-react/workspace/use-inbox-host"
import { initialTabs } from "../../src/tui/workspace/terminal-tabs-core"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

const task: Task = {
  id: toTaskId("task-a"),
  title: "Alpha",
  repo: "/tmp/project-a",
  branch: "a",
  worktreePath: "/tmp/a",
  status: "in_progress",
  archived: false,
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
}

function Probe(props: {
  orchestrator: RemoteOrchestrator
  items: readonly AttentionInboxItem[]
  selectedId?: string | null
  selectTask?: (taskId: string) => void
  focusWorkspace?: () => void
  notifyError?: (message: string) => void
  onReady?: (inbox: ReturnType<typeof useInboxHost>) => void
}) {
  const kv = useKV()
  const dialog = useDialog()
  const inbox = useInboxHost({
    orchestrator: props.orchestrator,
    items: props.items,
    tasks: [task],
    kv,
    dialog,
    selectedId: props.selectedId ?? null,
    selectTask: props.selectTask ?? (() => {}),
    focusWorkspace: props.focusWorkspace ?? (() => {}),
    notifyError: props.notifyError ?? (() => {}),
  })
  props.onReady?.(inbox)
  return <text>{`INBOX ${inbox.counts.total}`}</text>
}

function fakeOrchestrator(items: readonly AttentionInboxItem[], dismissed: Array<[string, string | null, number]>) {
  const inbox = createStateCell(items)
  const tasks = createStateCell([task])
  return {
    dismissAttention: async (taskId: string, tabId: string | null, at: number) => {
      dismissed.push([taskId, tabId, at])
    },
    getTask: (taskId: string) => (taskId === task.id ? task : undefined),
    attentionInboxSignal: () => inbox,
    tasksSignal: () => tasks,
  } as unknown as RemoteOrchestrator
}

describe("Inbox host", () => {
  it("drops unavailable items from the header count and silently dismisses them", async () => {
    const dismissed: Array<[string, string | null, number]> = []
    const items: AttentionInboxItem[] = [
      { taskId: task.id, tabId: null, state: "turn_complete", unread: true, at: 1 },
      { taskId: task.id, tabId: "closed", state: "error", unread: true, at: 2 },
      { taskId: "deleted", tabId: null, state: "error", unread: true, at: 3 },
    ]
    const orchestrator = fakeOrchestrator(items, dismissed)
    const { frame } = await renderComponent(<Probe orchestrator={orchestrator} items={items} />, {
      providers: { dialog: true, kv: true },
      width: 30,
      height: 5,
    })

    expect(await frame()).toContain("INBOX 1")
    expect(dismissed).toEqual([
      [task.id, "closed", 2],
      ["deleted", null, 3],
    ])
  })

  it("keeps open, delete, and visited resolution on the same host controller", async () => {
    const available: AttentionInboxItem = {
      taskId: task.id,
      tabId: null,
      state: "permission_needed",
      unread: true,
      at: 10,
    }
    const dismissed: Array<[string, string | null, number]> = []
    const selected: string[] = []
    let focused = 0
    let controller: ReturnType<typeof useInboxHost> | undefined
    const orchestrator = fakeOrchestrator([available], dismissed)
    const { frame, mockInput } = await renderComponent(
      <Probe
        orchestrator={orchestrator}
        items={[available]}
        selectTask={(taskId) => selected.push(taskId)}
        focusWorkspace={() => focused++}
        onReady={(next) => {
          controller = next
        }}
      />,
      { providers: { dialog: true, kv: true }, width: 60, height: 16 },
    )

    act(() => controller?.show())
    expect(await frame()).toContain("INBOX 1")
    act(() => mockInput.pressKey("d"))
    expect(dismissed).toContainEqual([task.id, null, 10])

    act(() => controller?.openItem(available))
    expect(selected).toEqual([task.id])
    expect(focused).toBe(1)

    const tabItem = { ...available, tabId: "tab-2", at: 11 }
    act(() => controller?.openItem(tabItem, true))
    expect(takeTabActivation(task.id)).toBe("tab-2")

    act(() => controller?.resolveVisited(task.id, "tab-1"))
    expect(dismissed.filter((entry) => entry[2] === 10)).toHaveLength(3)
  })

  it("resolves an episode that arrives for the currently visible task", async () => {
    const available: AttentionInboxItem = {
      taskId: task.id,
      tabId: null,
      state: "turn_complete",
      unread: true,
      at: 20,
    }
    const dismissed: Array<[string, string | null, number]> = []
    tabsByTask.set(task.id, initialTabs())
    try {
      const { frame } = await renderComponent(
        <Probe orchestrator={fakeOrchestrator([available], dismissed)} items={[available]} selectedId={task.id} />,
        { providers: { dialog: true, kv: true }, width: 30, height: 5 },
      )
      await frame()
      expect(dismissed).toEqual([[task.id, null, 20]])
    } finally {
      tabsByTask.delete(task.id)
    }
  })
})
