/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import type { AttentionInboxItem, RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { useKV } from "../../src/tui-react/context/kv"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { useInboxHost } from "../../src/tui-react/workspace/use-inbox-host"
import type { Task } from "../../src/types/task"
import { toTaskId } from "../../src/types/task"
import { renderComponent } from "./harness"

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
}) {
  const kv = useKV()
  const dialog = useDialog()
  const inbox = useInboxHost({
    orchestrator: props.orchestrator,
    items: props.items,
    tasks: [task],
    kv,
    dialog,
    selectedId: null,
    selectTask: () => {},
    focusWorkspace: () => {},
    notifyError: () => {},
  })
  return <text>{`INBOX ${inbox.counts.total}`}</text>
}

describe("Inbox host", () => {
  it("drops unavailable items from the header count and silently dismisses them", async () => {
    const dismissed: Array<[string, string | null, number]> = []
    const orchestrator = {
      dismissAttention: async (taskId: string, tabId: string | null, at: number) => {
        dismissed.push([taskId, tabId, at])
      },
      getTask: (taskId: string) => (taskId === task.id ? task : undefined),
    } as unknown as RemoteOrchestrator
    const items: AttentionInboxItem[] = [
      { taskId: task.id, tabId: null, state: "turn_complete", unread: true, at: 1 },
      { taskId: task.id, tabId: "closed", state: "error", unread: true, at: 2 },
      { taskId: "deleted", tabId: null, state: "error", unread: true, at: 3 },
    ]
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
})
