/** @jsxImportSource @opentui/react */

import { describe, expect, it } from "bun:test"
import { type CapturedFrame, RGBA } from "@opentui/core"
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { useEffect } from "react"
import { type AttentionInboxItem, RemoteOrchestrator } from "../../src/client/remote-orchestrator"
import { useKV } from "../../src/tui-react/context/kv"
import { setTransparentBackground } from "../../src/tui-react/context/theme"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { AttentionInboxDialog, AttentionInboxPane } from "../../src/tui-react/workspace/AttentionInboxPane"
import { BUNDLED_THEME_JSONS } from "../../src/tui/context/theme/bundled"
import { resolveThemeSlotHex } from "../../src/tui/context/theme/hex"
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
  star?.({ name: "task.snapshot", payload: { tasks } })
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

function backgroundWidth(frame: CapturedFrame, needle: string, color: RGBA): number {
  const line = frame.lines.find((candidate) => candidate.spans.some((span) => span.text.includes(needle)))
  return line?.spans.reduce((width, span) => width + (span.bg?.equals(color) ? span.width : 0), 0) ?? 0
}

function selectionBarColor(frame: CapturedFrame, needle: string): RGBA | undefined {
  const line = frame.lines.find((candidate) => candidate.spans.some((span) => span.text.includes(needle)))
  return line?.spans.find((span) => span.text.includes("▌"))?.fg
}

function lineIndex(frame: CapturedFrame, needle: string): number {
  return frame.lines.findIndex((candidate) => candidate.spans.some((span) => span.text.includes(needle)))
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

  it("renders pending episodes oldest-first and exposes dialog-local navigation/open/delete", async () => {
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
    // No read/unread lifecycle — the header is just the pending count.
    expect(text).not.toContain("Unread")
    expect(text).toContain("Alpha")
    expect(text).toContain("Beta")
    expect(text).toContain("2m")
    expect(text).toContain("2h")
    // Identity-first card: line 1 leads with `project` (plus `› tab` when
    // the episode carries one) + the state word; the task title is line 2.
    expect(text).toContain("? needs input")
    expect(text).toContain("✓ done")
    const alphaIdentity = text.indexOf("project-a")
    expect(alphaIdentity).toBeLessThan(text.indexOf("Alpha"))
    // Queue drains top-down: Beta's episode (2h) is OLDER than Alpha's (2m),
    // so it renders first.
    expect(text.indexOf("Beta")).toBeLessThan(text.indexOf("Alpha"))

    act(() => mockInput.pressKey("j"))
    act(() => mockInput.pressKey("d"))
    act(() => mockInput.pressEnter())
    expect(deleted).toEqual(["task-a"])
    expect(opened).toEqual(["task-a"])
  })

  it("marks only the active card with the SHARED sidebar cursor chrome, stable in opaque and transparent modes", async () => {
    // One cursor vocabulary across navigable lists: the Inbox routes
    // through resolveRowSelectionChrome, so its bar color (theme.text) and
    // row tint match the sidebar's cursor row exactly — regressing to a
    // pane-local color scheme is what this pins against.
    const theme = BUNDLED_THEME_JSONS.claude!
    const backgroundElement = RGBA.fromHex(resolveThemeSlotHex(theme, "backgroundElement")!)
    const cursorMarker = RGBA.fromHex(resolveThemeSlotHex(theme, "text")!)
    try {
      for (const transparent of [false, true]) {
        setTransparentBackground(transparent)
        const { spans, destroy, mockInput } = await renderComponent(<Probe onOpen={() => {}} onDelete={() => {}} />, {
          providers: { kv: true },
          width: 60,
          height: 24,
        })
        try {
          const frame = await spans()
          // Active card (cursor starts on the OLDEST episode — Beta's 2h):
          // ▌ bar in the shared cursor color + backgroundElement row tint;
          // inactive card: no bar, no tint (transparent stays transparent).
          expect(selectionBarColor(frame, "Beta")?.equals(cursorMarker)).toBe(true)
          expect(selectionBarColor(frame, "Alpha")).toBeUndefined()
          expect(backgroundWidth(frame, "Beta", backgroundElement)).toBeGreaterThan(0)
          expect(backgroundWidth(frame, "Alpha", backgroundElement)).toBe(0)
          const alphaY = lineIndex(frame, "Alpha")
          const betaY = lineIndex(frame, "Beta")

          act(() => mockInput.pressKey("j"))
          const moved = await spans()
          expect(selectionBarColor(moved, "Beta")).toBeUndefined()
          expect(selectionBarColor(moved, "Alpha")?.equals(cursorMarker)).toBe(true)
          expect(backgroundWidth(moved, "Alpha", backgroundElement)).toBeGreaterThan(0)
          // Moving the cursor must not shift card geometry.
          expect(lineIndex(moved, "Alpha")).toBe(alphaY)
          expect(lineIndex(moved, "Beta")).toBe(betaY)
        } finally {
          destroy()
        }
      }
    } finally {
      setTransparentBackground(true)
    }
  })

  it("silently clears a closed Terminal Tab before rendering the queue", async () => {
    const deleted: string[] = []
    const { frame } = await renderComponent(
      <Probe
        items={[items[1], { taskId: "task-a", tabId: "closed-tab", state: "error", unread: true, at: 10 }]}
        onOpen={() => {}}
        onDelete={(item) => deleted.push(`${item.taskId}:${item.tabId}`)}
      />,
      { providers: { kv: true }, width: 60, height: 16 },
    )
    const text = await frame()
    expect(text).toContain("INBOX 1")
    expect(text).toContain("Alpha")
    expect(text).not.toContain("closed-tab")
    expect(text).not.toContain("unavailable")
    expect(deleted).toEqual(["task-a:closed-tab"])
  })

  it("silently clears an item whose source Task was deleted", async () => {
    const deleted: string[] = []
    const { frame } = await renderComponent(
      <Probe
        items={[{ taskId: "deleted-task", tabId: null, state: "error", unread: true, at: 10 }]}
        onOpen={() => {}}
        onDelete={(item) => deleted.push(item.taskId)}
      />,
      { providers: { kv: true }, width: 60, height: 16 },
    )
    const text = await frame()
    expect(text).toContain("INBOX 0")
    expect(text).toContain("No pending attention")
    expect(text).not.toContain("deleted-task")
    expect(text).not.toContain("unavailable")
    expect(deleted).toEqual(["deleted-task"])
  })

  it("caps the card viewport at six items and follows the cursor", async () => {
    const manyTasks = Array.from(
      { length: 7 },
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

    expect(await frame()).toContain("Item 6")
    expect(await frame()).not.toContain("Item 7")

    act(() => {
      for (let index = 0; index < 6; index++) mockInput.pressKey("j")
    })
    expect(await frame()).toContain("Item 7")
    expect(await frame()).not.toContain("Item 1")
  })
})
