/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import type { AttentionInboxItem } from "../../src/client/remote-orchestrator"
import { useKV } from "../../src/tui-react/context/kv"
import { ATTENTION_INBOX_BORDER, AttentionInboxPane } from "../../src/tui-react/workspace/AttentionInboxPane"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

process.env.KOBE_HOME_DIR = process.env.KOBE_HOME_DIR ?? "/tmp/kobe-attention-inbox-render-test"

const tasks: Task[] = [
  {
    id: toTaskId("task-a"),
    title: "Alpha",
    repo: "/tmp/a",
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
    repo: "/tmp/b",
    branch: "b",
    worktreePath: "/tmp/b",
    status: "in_progress",
    archived: false,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  },
]

const items: AttentionInboxItem[] = [
  { taskId: "task-b", tabId: null, state: "turn_complete", unread: false, at: 10 },
  { taskId: "task-a", tabId: null, state: "permission_needed", unread: true, at: 20 },
]

function Probe(props: {
  onOpen: (item: AttentionInboxItem) => void
  onDelete: (item: AttentionInboxItem) => void
  items?: AttentionInboxItem[]
}) {
  const kv = useKV()
  return (
    <AttentionInboxPane
      items={props.items ?? items}
      tasks={tasks}
      kv={kv}
      focused={true}
      onOpen={props.onOpen}
      onDelete={props.onDelete}
      onRequestFocus={() => {}}
    />
  )
}

describe("AttentionInboxPane", () => {
  it("shares one divider line with the Files pane", async () => {
    const { frame } = await renderComponent(
      <box flexDirection="column">
        <box height={4} borderColor="white">
          <text>FILES</text>
        </box>
        <box height={4} border={ATTENTION_INBOX_BORDER} borderColor="white">
          <text>INBOX</text>
        </box>
      </box>,
      { width: 24, height: 8 },
    )
    const lines = (await frame()).split("\n")
    const inboxLine = lines.findIndex((line) => line.includes("INBOX"))
    expect(lines[inboxLine - 1]).toContain("└")
    expect(lines[inboxLine]).not.toContain("┌")
  })

  it("renders the empty Inbox state", async () => {
    const { frame } = await renderComponent(<Probe items={[]} onOpen={() => {}} onDelete={() => {}} />, {
      providers: { kv: true },
      width: 46,
      height: 8,
    })
    const text = await frame()
    expect(text).toContain("INBOX 0")
    expect(text).toContain("No pending attention")
  })

  it("renders retained episodes and exposes pane-local navigation/open/delete", async () => {
    const opened: string[] = []
    const deleted: string[] = []
    const { frame, mockInput } = await renderComponent(
      <Probe onOpen={(item) => opened.push(item.taskId)} onDelete={(item) => deleted.push(item.taskId)} />,
      { providers: { kv: true }, width: 46, height: 8 },
    )
    const text = await frame()
    expect(text).toContain("INBOX 2")
    expect(text).toContain("Alpha")
    expect(text).toContain("Beta")
    expect(text).toContain("• ? Alpha")

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
      { providers: { kv: true }, width: 60, height: 8 },
    )
    const text = await frame()
    expect(text).toContain("closed-tab")
    expect(text).toContain("unavailable")
  })
})
