/**
 * Experimental native opentui workspace (`KOBE_TUI=1`).
 *
 * This is the v0.5-shaped single-process app: Sidebar | Chat | Files/Terminal.
 * The default product path stays the tmux handover; this host is intentionally
 * gated behind `KOBE_TUI=1` while the headless chat backend proves out.
 */

import { join } from "node:path"
import { useTerminalDimensions } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { ChatPane } from "../chat/ChatPane"
import { HelpDialog } from "../component/help-dialog"
import { type PaneId, useFocus } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { FileTree } from "../panes/filetree/FileTree"
import { openExternally } from "../panes/filetree/open-external"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { Terminal } from "../panes/terminal/Terminal"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const SIDEBAR_WIDTH = 32
const WORKTREE_TOOLS_MIN_WIDTH = 22
const WORKTREE_TOOLS_MAX_WIDTH = 34
const PANE_BY_SLOT = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

function firstSelectableTask(tasks: readonly Task[], activeId: string | null): Task | undefined {
  const active = activeId ? tasks.find((task) => task.id === activeId && !task.archived) : undefined
  if (active) return active
  return tasks.find((task) => !task.archived) ?? tasks[0]
}

function taskWorktree(task: Task | undefined): string | null {
  if (!task) return null
  return task.worktreePath || null
}

function WorkspaceRoot(props: { orchestrator: RemoteOrchestrator }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const focus = useFocus()
  const dims = useTerminalDimensions()
  const [selectedId, setSelectedId] = createSignal<string | null>(props.orchestrator.activeTaskSignal()())

  const tasks = props.orchestrator.tasksSignal()
  const worktreeToolsWidth = createMemo(() => {
    const available = Math.max(WORKTREE_TOOLS_MIN_WIDTH, dims().width - SIDEBAR_WIDTH)
    return Math.max(WORKTREE_TOOLS_MIN_WIDTH, Math.min(WORKTREE_TOOLS_MAX_WIDTH, Math.floor(available / 3)))
  })
  const selectedTask = createMemo<Task | undefined>(() => {
    const id = selectedId()
    return id ? tasks().find((task) => task.id === id) : undefined
  })
  const worktree = createMemo(() => taskWorktree(selectedTask()))

  createEffect(
    on(
      [tasks, props.orchestrator.activeTaskSignal()],
      ([list, activeId]) => {
        const current = selectedId()
        if (current && list.some((task) => task.id === current)) return
        setSelectedId(firstSelectableTask(list, activeId)?.id ?? null)
      },
      { defer: false },
    ),
  )

  function selectTask(id: string): void {
    setSelectedId(id)
    void props.orchestrator.setActiveTask(id).catch((err) => {
      console.error("[kobe workspace] setActiveTask failed:", err)
    })
  }

  async function activateTask(id: string): Promise<void> {
    const task = tasks().find((t) => t.id === id)
    if (!task) return
    if (!task.worktreePath) {
      try {
        await props.orchestrator.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe workspace] task.ensureWorktree failed:", err)
        return
      }
    }
    selectTask(id)
    focus.setFocused("workspace")
  }

  async function quit(): Promise<void> {
    const ok = await DialogConfirm.show(
      dialog,
      "Quit kobe?",
      "The daemon and task sessions keep running. This closes only the native workspace.",
      "quit",
    )
    if (ok) process.exit(0)
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      ...bindByIds({
        "help.open": () => HelpDialog.show(dialog),
        "focus.numeric": (_evt, slot) => {
          const pane = PANE_BY_SLOT[slot ?? 0]
          if (pane) focus.setFocused(pane)
        },
      }),
    ],
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !focus.is("sidebar")(),
    bindings: bindByIds({
      "focus.sidebar": () => focus.setFocused("sidebar"),
    }),
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && focus.is("sidebar")(),
    bindings: bindByIds({
      // Slot dispatch (SLOT_CONTRACTS): slot 0 = quit confirm, slot 1 =
      // hard exit — so user rebinds keep both verbs without inspecting
      // the event's modifiers.
      "app.quit": (_evt, slot) => {
        if (slot === 1) process.exit(0)
        void quit()
      },
    }),
  }))

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      <box
        width={SIDEBAR_WIDTH}
        flexShrink={0}
        borderColor={focus.is("sidebar")() ? theme.focusAccent : theme.border}
        onMouseUp={() => focus.setFocused("sidebar")}
      >
        <Sidebar
          tasks={tasks}
          selectedId={selectedId}
          onSelect={selectTask}
          onActivate={(id) => void activateTask(id)}
          engineState={props.orchestrator.engineStateSignal()}
          taskJobs={props.orchestrator.taskJobsSignal()}
          worktreeChanges={props.orchestrator.worktreeChangesSignal()}
          focused={focus.is("sidebar")}
        />
      </box>

      <box
        flexGrow={1}
        flexShrink={1}
        borderColor={focus.is("workspace")() ? theme.focusAccent : theme.border}
        onMouseUp={() => focus.setFocused("workspace")}
      >
        <ShowWorkspace task={selectedTask()} worktree={worktree()} focused={focus.is("workspace")} />
      </box>

      <box width={worktreeToolsWidth()} flexShrink={0} flexDirection="column">
        <box
          flexGrow={3}
          flexShrink={1}
          borderColor={focus.is("files")() ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("files")}
        >
          <FileTree
            worktreePath={worktree}
            focused={focus.is("files")}
            onOpenFile={(relPath) => {
              const root = worktree()
              if (root) openExternally(join(root, relPath))
            }}
          />
        </box>
        <box
          flexGrow={2}
          flexShrink={1}
          borderColor={focus.is("terminal")() ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("terminal")}
        >
          <Terminal cwd={worktree} taskId={() => selectedTask()?.id ?? null} focused={focus.is("terminal")} />
        </box>
      </box>
    </box>
  )
}

function ShowWorkspace(props: { task: Task | undefined; worktree: string | null; focused: () => boolean }) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.worktree}
      fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task with a worktree</text>
        </box>
      }
      keyed
    >
      {(path) => <ChatPane worktree={path} title={props.task?.title} focused={props.focused} />}
    </Show>
  )
}

export async function startWorkspaceHost(): Promise<void> {
  await bootPaneHost({
    logContext: "workspace",
    providers: { kv: true, focus: true, notifications: true },
    setup: async () => {
      const client = await connectOrStartDaemon()
      const orchestrator = new RemoteOrchestrator(client, { role: "gui" })
      await orchestrator.init()
      process.env.KOBE_DAEMON_SOCKET_PATH = client.socketPath
      return {
        root: () => <WorkspaceRoot orchestrator={orchestrator} />,
        onDestroy: () => orchestrator.dispose(),
      }
    },
  })
}
