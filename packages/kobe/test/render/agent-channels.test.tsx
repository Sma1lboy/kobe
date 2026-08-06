/** @jsxImportSource @opentui/react */

import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStateCell } from "../../src/lib/external-store"
import type { AgentChannel } from "../../src/state/agent-channels"
import { TaskChannelPickerView } from "../../src/tui-react/component/task-channel-picker-dialog"
import { useKV } from "../../src/tui-react/context/kv"
import { useT } from "../../src/tui-react/i18n"
import { AgentChannelRail } from "../../src/tui-react/panes/sidebar/agent-channel-rail"
import { useDialog } from "../../src/tui-react/ui/dialog"
import { AgentChannelWorkspace } from "../../src/tui-react/workspace/AgentChannelWorkspace"
import type { TerminalTabs } from "../../src/tui-react/workspace/TerminalTabs"
import { HostTerminalContent } from "../../src/tui-react/workspace/host-terminal-content"
import { tabsByTask } from "../../src/tui-react/workspace/terminal-tabs-shared"
import { useAgentChannels } from "../../src/tui-react/workspace/use-agent-channels"
import { type Task, toTaskId } from "../../src/types/task"
import { act, renderComponent } from "./harness"

const NOOP = (): void => {}
process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-channel-render-"))

function task(id: string, title: string, vendor: "claude" | "codex" | "copilot" = "claude"): Task {
  return {
    id: toTaskId(id),
    title,
    repo: `/tmp/${id}`,
    branch: id,
    worktreePath: `/tmp/${id}`,
    status: "in_progress",
    archived: false,
    vendor,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  }
}

const left = task("task-a", "Parser refactor", "codex")
const right = task("task-b", "Desktop shell")
const channel: AgentChannel = {
  id: "channel-1",
  createdAt: "2026-08-06T00:00:00.000Z",
  endpoints: [
    { taskId: left.id, tabId: "tab-2" },
    { taskId: right.id, tabId: "tab-3" },
  ],
}

function ChannelHookProbe(props: {
  tasks: readonly Task[]
  source?: Task
  notifyError: (message: string) => void
  onValue: (value: ReturnType<typeof useAgentChannels>) => void
}) {
  const value = useAgentChannels({
    tasks: props.tasks,
    selectedTask: props.source,
    kv: useKV(),
    dialog: useDialog(),
    t: useT(),
    notifyError: props.notifyError,
    onOpen: NOOP,
  })
  props.onValue(value)
  return <text>{value.selectedChannelId ?? "no-channel"}</text>
}

function fakeOrchestrator() {
  const activity = createStateCell(new Map())
  const tabStates = createStateCell(new Map())
  return {
    transcriptActivityStore: () => activity,
    engineTabStatesSignal: () => tabStates,
  } as never
}

test("task picker presents engine-owned identities and keyboard selection", async () => {
  let selected = ""
  const { frame, mockInput } = await renderComponent(
    <TaskChannelPickerView
      source={left}
      tasks={[left, right]}
      onSubmit={(value) => {
        selected = value.id
      }}
    />,
    { width: 70, height: 18, providers: { dialog: true } },
  )
  const text = await frame()
  expect(text).toContain("Connect this chat")
  expect(text).toContain("Desktop shell")
  expect(text).toContain("Claude")
  await act(async () => mockInput.pressEnter())
  expect(selected).toBe(right.id)
})

test("CHANNELS rail names both task endpoints and highlights the open pair", async () => {
  const { frame } = await renderComponent(
    <AgentChannelRail
      channels={[channel]}
      tasks={[left, right]}
      selectedChannelId={channel.id}
      onSelectChannel={NOOP}
    />,
    { width: 30, height: 10 },
  )
  const text = await frame()
  expect(text).toContain("CHANNELS")
  expect(text).toContain("Parser refactor")
  expect(text).toContain("⇄")
})

test("channel workspace fails closed when an endpoint tab disappeared", async () => {
  const { frame } = await renderComponent(
    <AgentChannelWorkspace
      channel={channel}
      tasks={[left, right]}
      orchestrator={fakeOrchestrator()}
      focused={true}
      onRequestFocus={NOOP}
    />,
    { width: 100, height: 24, providers: { kv: true } },
  )
  expect(await frame()).toContain("endpoint tasks is unavailable")
})

test("channel workspace renders two pinned native-tab endpoints", async () => {
  tabsByTask.set(left.id, {
    tabs: [{ kind: "engine", id: "tab-2", title: null, ordinal: 2, vendor: "codex" }],
    activeId: "tab-2",
    nextOrdinal: 3,
  })
  tabsByTask.set(right.id, {
    tabs: [{ kind: "engine", id: "tab-3", title: null, ordinal: 3, vendor: "claude" }],
    activeId: "tab-3",
    nextOrdinal: 4,
  })
  const StubTabs = ((props: { taskId: string; pinnedTabId?: string }) => (
    <text>{`PTY ${props.taskId} ${props.pinnedTabId}`}</text>
  )) as typeof TerminalTabs
  const { frame } = await renderComponent(
    <AgentChannelWorkspace
      channel={channel}
      tasks={[left, right]}
      orchestrator={fakeOrchestrator()}
      focused={true}
      onRequestFocus={NOOP}
      TerminalTabsComponent={StubTabs}
    />,
    { width: 100, height: 24, providers: { kv: true } },
  )
  const text = await frame()
  expect(text).toContain("AGENT CHANNEL")
  expect(text).toContain("CODEX")
  expect(text).toContain("CLAUDE")
  expect(text).toContain("PTY task-a tab-2")
  expect(text).toContain("PTY task-b tab-3")
  tabsByTask.clear()
})

test("host content keeps the ordinary empty workspace when no channel is selected", async () => {
  const { frame } = await renderComponent(
    <HostTerminalContent
      tasks={[left, right]}
      task={undefined}
      worktree={null}
      orchestrator={fakeOrchestrator()}
      focused={true}
      onRequestFocus={NOOP}
      onEditorTabReady={NOOP}
      onEngineSendReady={NOOP}
      onDiffTabReady={NOOP}
      onQuickFork={NOOP}
    />,
    { width: 80, height: 20 },
  )
  expect(await frame()).toContain("Select a task")
})

test("channel hook opens/leaves records and refuses a non-forking target", async () => {
  const unsupported = task("task-c", "Copilot target", "copilot")
  const errors: string[] = []
  let api: ReturnType<typeof useAgentChannels> | undefined
  const { frame, mockInput } = await renderComponent(
    <ChannelHookProbe
      tasks={[left, unsupported]}
      source={left}
      notifyError={(message) => errors.push(message)}
      onValue={(value) => {
        api = value
      }}
    />,
    { width: 80, height: 20, providers: { kv: true, dialog: true } },
  )

  await act(async () => api?.openChannel(channel))
  expect(await frame()).toContain(channel.id)
  await act(async () => api?.leaveChannel())
  expect(await frame()).toContain("no-channel")

  await act(async () => api?.connectCurrent())
  expect(await frame()).toContain("Copilot target")
  await act(async () => {
    mockInput.pressEnter()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(errors).toEqual(["Copilot cannot fork a native chat session"])
})

test("channel hook forks both native chats once and reopening reuses the endpoints", async () => {
  tabsByTask.clear()
  tabsByTask.set(left.id, {
    tabs: [
      {
        kind: "engine",
        id: "tab-1",
        title: null,
        ordinal: 1,
        vendor: "codex",
        sessionId: "codex-source",
      },
    ],
    activeId: "tab-1",
    nextOrdinal: 2,
  })
  tabsByTask.set(right.id, {
    tabs: [
      {
        kind: "engine",
        id: "tab-1",
        title: null,
        ordinal: 1,
        vendor: "claude",
        sessionId: "claude-source",
      },
    ],
    activeId: "tab-1",
    nextOrdinal: 2,
  })
  let api: ReturnType<typeof useAgentChannels> | undefined
  const { frame, mockInput } = await renderComponent(
    <ChannelHookProbe
      tasks={[left, right]}
      source={left}
      notifyError={NOOP}
      onValue={(value) => {
        api = value
      }}
    />,
    { width: 80, height: 20, providers: { kv: true, dialog: true } },
  )

  await act(async () => api?.connectCurrent())
  await act(async () => {
    mockInput.pressEnter()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  await frame()
  expect(api?.channels).toHaveLength(1)
  expect(api?.selectedChannelId).toBe(api?.channels[0]?.id)
  expect(tabsByTask.get(left.id)?.tabs).toHaveLength(2)
  expect(tabsByTask.get(right.id)?.tabs).toHaveLength(2)
  expect(tabsByTask.get(left.id)?.tabs[1]).toMatchObject({ forkFrom: "codex-source", vendor: "codex" })
  expect(tabsByTask.get(right.id)?.tabs[1]).toMatchObject({ forkFrom: "claude-source", vendor: "claude" })

  const created = api?.channels[0]
  if (!created) throw new Error("channel was not created")
  await act(async () => api?.openChannel(created))
  expect(tabsByTask.get(left.id)?.tabs).toHaveLength(2)
  expect(tabsByTask.get(right.id)?.tabs).toHaveLength(2)
  tabsByTask.clear()
})
