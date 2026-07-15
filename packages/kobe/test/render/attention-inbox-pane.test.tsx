/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { useEffect } from "react"
import { type AttentionInboxItem, RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { useKV } from "../../src/tui-react/context/kv"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { AttentionInboxDialog, AttentionInboxPane } from "../../src/tui-react/workspace/AttentionInboxPane"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

process.env.KOBE_HOME_DIR = process.env.KOBE_HOME_DIR ?? "/tmp/kobe-attention-inbox-render-test"

const tasks: Task[] = [
  {
    id: toTaskId("task-a"),
    title: "Alpha",
    repo: "/tmp/project-a",
    branch: "a",
    worktreePath: "/tmp/a",
    status: "in_progress",
    archived: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
  {
    id: toTaskId("task-b"),
    title: "Beta",
    repo: "/tmp/project-b",
    branch: "b",
    worktreePath: "/tmp/b",
    status: "in_progress",
    archived: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
]

const now = Date.now()
const items: AttentionInboxItem[] = [
  { taskId: "task-b", tabId: null, state: "turn_complete", unread: false, at: now - 2 * 60 * 60 * 1000 },
  { taskId: "task-a", tabId: null, state: "permission_needed", unread: true, at: now - 2 * 60 * 1000 },
]

function Probe(props: {
  onOpen: (item: AttentionInboxItem) => void
  onDelete: (item: AttentionInboxItem) => void
  items?: AttentionInboxItem[]
  tasks?: Task[]
}) {
  const kv = useKV()
  return (
    <AttentionInboxPane
      items={props.items ?? items}
      tasks={props.tasks ?? tasks}
      kv={kv}
      onOpen={props.onOpen}
      onDelete={props.onDelete}
      onClose={() => {}}
    />
  )
}

function remoteInbox(initial: AttentionInboxItem[]) {
  let star: ((frame: { name: string; payload: unknown }) => void) | undefined
  const client = {
    on: (name: string, handler: (frame: { name: string; payload: unknown }) => void) => {
      if (name === "*") star = handler
      return () => {}
    },
    onLifecycle: () => () => {},
  } as unknown as KobeDaemonClient
  const orchestrator = new RemoteOrchestrator(client)
  const emit = (next: AttentionInboxItem[]) => star?.({ name: "attention.inbox", payload: { items: next } })
  emit(initial)
  return { orchestrator, emit }
}

function DialogProbe(props: { orchestrator: RemoteOrchestrator }) {
  const dialog = useDialog()
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once show.
  useEffect(() => {
    AttentionInboxDialog.show(dialog, {
      orchestrator: props.orchestrator,
      onOpen: () => {},
      onDelete: () => {},
    })
  }, [])
  return <box />
}

describe("AttentionInboxPane", () => {
  it("opens as a modal and stays live with daemon Inbox snapshots", async () => {
    const remote = remoteInbox(items)
    const { frame } = await renderComponent(<DialogProbe orchestrator={remote.orchestrator} />, {
      providers: { dialog: true, kv: true },
      width: 90,
      height: 24,
    })
    expect(await frame()).toContain("INBOX 2")

    act(() => remote.emit([]))
    expect(await frame()).toContain("No pending attention")
  })

  it("renders the empty Inbox state", async () => {
    const { frame } = await renderComponent(<Probe items={[]} onOpen={() => {}} onDelete={() => {}} />, {
      providers: { kv: true },
      width: 46,
      height: 16,
    })
    const text = await frame()
    expect(text).toContain("INBOX 0")
    expect(text).toContain("No pending attention")
  })

  it("renders retained episodes and exposes dialog-local navigation/open/delete", async () => {
    const opened: string[] = []
    const deleted: string[] = []
    const { frame, mockInput } = await renderComponent(
      <Probe
        tasks={[...tasks].reverse()}
        onOpen={(item) => opened.push(item.taskId)}
        onDelete={(item) => deleted.push(item.taskId)}
      />,
      { providers: { kv: true }, width: 60, height: 24 },
    )
    const text = await frame()
    expect(text).toContain("INBOX 2")
    expect(text).toContain("Alpha")
    expect(text).toContain("Beta")
    expect(text).toContain("project-a")
    expect(text).toContain("project-b")
    expect(text).toContain("2m")
    expect(text).toContain("2h")
    expect(text).toContain("• ? Alpha")
    expect(text).not.toContain("project-a ─")
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"))

    act(() => mockInput.pressKey("j"))
    act(() => mockInput.pressKey("d"))
    act(() => mockInput.pressEnter())
    expect(deleted).toEqual(["task-b"])
    expect(opened).toEqual(["task-b"])
  })

  it("keeps a closed chat tab visible as unavailable", async () => {
    const { frame } = await renderComponent(
      <Probe
        items={[{ taskId: "task-a", tabId: "closed-tab", state: "error", unread: true, at: 10 }]}
        onOpen={() => {}}
        onDelete={() => {}}
      />,
      { providers: { kv: true }, width: 60, height: 16 },
    )
    const text = await frame()
    expect(text).toContain("closed-tab")
    expect(text).toContain("unavailable")
  })

  it("shows one unavailable label when the source task was deleted", async () => {
    const { frame } = await renderComponent(
      <Probe
        items={[{ taskId: "deleted-task", tabId: null, state: "error", unread: true, at: 10 }]}
        onOpen={() => {}}
        onDelete={() => {}}
      />,
      { providers: { kv: true }, width: 60, height: 16 },
    )
    const text = await frame()
    expect(text).toContain("deleted-task")
    expect(text.match(/unavailable/g)).toHaveLength(1)
  })

  it("caps the card viewport at four items and follows the cursor", async () => {
    const manyTasks = Array.from(
      { length: 5 },
      (_, index): Task => ({
        ...tasks[0],
        id: toTaskId(`task-${index + 1}`),
        title: `Item ${index + 1}`,
        repo: `/tmp/project-${index + 1}`,
      }),
    )
    const manyItems = manyTasks.map(
      (task, index): AttentionInboxItem => ({
        taskId: task.id,
        tabId: null,
        state: "permission_needed",
        unread: true,
        at: now + index,
      }),
    )
    const { frame, mockInput } = await renderComponent(
      <Probe tasks={manyTasks} items={manyItems} onOpen={() => {}} onDelete={() => {}} />,
      { providers: { kv: true }, width: 60, height: 40 },
    )

    expect(await frame()).toContain("Item 4")
    expect(await frame()).not.toContain("Item 5")

    act(() => {
      for (let index = 0; index < 4; index++) mockInput.pressKey("j")
    })
    expect(await frame()).toContain("Item 5")
    expect(await frame()).not.toContain("Item 1")
  })
})
