import { join } from "node:path"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { resolveEditorLaunch } from "../../tmux/editor-launch.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import { HelpDialog } from "../component/help-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { type PaneId, useFocus } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { FileTree } from "../panes/filetree/FileTree"
import { openExternally } from "../panes/filetree/open-external"
import { Sidebar, type SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarHoverTooltip } from "../panes/sidebar/hover-tooltip"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { TerminalTabs } from "./TerminalTabs"

const SIDEBAR_WIDTH = 32
const WORKTREE_TOOLS_MIN_WIDTH = 22
const WORKTREE_TOOLS_MAX_WIDTH = 34
const PANE_BY_SLOT = ["sidebar", "workspace", "files"] as const satisfies readonly PaneId[]

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
  const kv = useKV()
  const focus = useFocus()
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const [selectedId, setSelectedId] = createSignal<string | null>(props.orchestrator.activeTaskSignal()())
  const [sidebarHover, setSidebarHover] = createSignal<SidebarHover | null>(null)

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

  let liveTaskIds = new Set<string>()
  createEffect(() => {
    const list = tasks()
    const next = new Set<string>(list.filter((task) => !task.archived).map((task) => task.id))
    const registry = getDefaultPtyRegistry()
    for (const id of liveTaskIds) {
      if (!next.has(id)) registry.releaseWhere((key) => key === id || key.startsWith(`${id}::`))
    }
    liveTaskIds = next
  })

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

  function exitApp(): void {
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    process.exit(0)
  }

  async function quit(): Promise<void> {
    const ok = await DialogConfirm.show(
      dialog,
      t("workspace.quit.confirmTitle"),
      t("workspace.quit.confirmBody"),
      t("common.cancel"),
      t("workspace.quit.confirmLabel"),
    )
    if (ok) exitApp()
  }

  let openEditorTabFn: ((command: readonly string[], label: string) => void) | null = null

  async function openFileInEditor(relPath: string): Promise<void> {
    const wt = worktree()
    if (!wt) return
    const abs = join(wt, relPath)
    const launch = openEditorTabFn ? await resolveEditorLaunch(wt, abs) : null
    if (!launch) {
      openExternally(abs)
      return
    }
    openEditorTabFn?.(["sh", "-c", launch.command], launch.label)
  }

  const [settingsOpen, setSettingsOpen] = createSignal(false)
  function openSettings(): void {
    setSettingsOpen(true)
  }
  function closeSettings(): void {
    setSettingsOpen(false)
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen(),
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
    enabled: dialog.stack.length === 0 && !settingsOpen() && !focus.is("sidebar")(),
    bindings: bindByIds({
      "focus.sidebar": () => focus.setFocused("sidebar"),
    }),
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && focus.is("sidebar")(),
    bindings: bindByIds({
      "app.quit": (_evt, slot) => {
        if (slot === 1) {
          exitApp()
          return
        }
        void quit()
      },
      "settings.open.sidebar": () => openSettings(),
    }),
  }))
  useBindings(() => ({
    enabled: settingsOpen() && dialog.stack.length === 0,
    bindings: [
      { key: "escape", cmd: closeSettings },
      { key: "q", cmd: closeSettings },
      { key: "ctrl+c", cmd: closeSettings },
    ],
  }))

  return (
    <Show
      when={!settingsOpen()}
      fallback={
        <scrollbox
          flexGrow={1}
          backgroundColor={theme.background}
          paddingTop={1}
          verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
        >
          <SettingsDialog kv={kv} orchestrator={props.orchestrator} standalone={true} onClose={closeSettings} />
        </scrollbox>
      }
    >
      <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
        <box
          width={SIDEBAR_WIDTH}
          flexShrink={0}
          borderColor={focus.is("sidebar")() ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("sidebar")}
        >
          <Sidebar
            width={() => SIDEBAR_WIDTH - 2}
            tasks={tasks}
            selectedId={selectedId}
            onSelect={selectTask}
            onActivate={(id) => void activateTask(id)}
            engineState={props.orchestrator.engineStateSignal()}
            taskJobs={props.orchestrator.taskJobsSignal()}
            worktreeChanges={props.orchestrator.worktreeChangesSignal()}
            focused={focus.is("sidebar")}
            onHoverChange={(hover) => setSidebarHover(hover)}
          />
        </box>

        <box
          flexGrow={1}
          flexShrink={1}
          borderColor={focus.is("workspace")() ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("workspace")}
        >
          <ShowWorkspace
            task={selectedTask()}
            worktree={worktree()}
            orchestrator={props.orchestrator}
            focused={focus.is("workspace")}
            onEditorTabReady={(open) => {
              openEditorTabFn = open
            }}
          />
        </box>

        <box
          width={worktreeToolsWidth()}
          flexShrink={0}
          borderColor={focus.is("files")() ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("files")}
        >
          <FileTree
            worktreePath={worktree}
            focused={focus.is("files")}
            onOpenFile={(relPath) => void openFileInEditor(relPath)}
          />
        </box>

        <SidebarHoverTooltip hover={sidebarHover} dims={dims} />
      </box>
    </Show>
  )
}

function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: () => boolean
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
}) {
  const { theme } = useTheme()
  return (
    <Show
      when={props.worktree}
      fallback={
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>{t("workspace.empty.selectTask")}</text>
        </box>
      }
      keyed
    >
      {(path) => (
        <TerminalTabs
          taskId={props.task?.id ?? path}
          worktree={path}
          command={interactiveEngineCommand(props.task?.vendor, props.task?.modelEffort)}
          vendor={props.task?.vendor ?? DEFAULT_TASK_VENDOR}
          modelEffort={props.task?.modelEffort}
          onChooseEngine={
            props.task
              ? (vendor) => {
                  const taskId = props.task?.id
                  if (!taskId) return
                  void props.orchestrator
                    .setVendor(taskId, vendor)
                    .catch((err) => console.error("[kobe workspace] task.setVendor failed:", err))
                }
              : undefined
          }
          focused={props.focused}
          onEditorTabReady={props.onEditorTabReady}
        />
      )}
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
        onDestroy: () => {
          orchestrator.dispose()
          getDefaultPtyRegistry().releaseAll()
        },
      }
    },
  })
}
