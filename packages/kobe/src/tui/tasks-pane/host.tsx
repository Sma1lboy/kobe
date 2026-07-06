import { currentSessionName, runTmuxCapturing } from "@/tmux/client"
import { ZEN_HIDDEN_PANES_OPTION } from "@/tmux/session-layout"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import {
  type CreateTaskContext,
  archiveTaskFlow,
  createTaskFlow,
  cycleVendorFlow,
  deleteTaskFlow,
  renameBranchFlow,
  renameTaskFlow,
} from "../lib/task-actions"
import { Sidebar } from "../panes/sidebar/Sidebar"
import type { TaskSortMode } from "../panes/sidebar/groups"
import { runLayoutAction } from "../panes/terminal/layout-actions.ts"
import { useDialog } from "../ui/dialog"
import {
  type SwitchToRef,
  type TasksHostActionsContext,
  buildTaskActionsContext,
  focusEnginePaneAction,
  moveTaskAction,
  openHelpAction,
  openSelectedWorktreeAction,
  openSettingsAction,
  openUpdateAction,
  openWorktreesAction,
  switchToAction,
  togglePinAction,
  togglePreviewFlowAction,
} from "./actions.ts"
import { setupTasksPane } from "./setup.tsx"
import { ShortcutHints } from "./shortcut-hints.tsx"

export function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  initialTaskId?: string
  orch: RemoteOrchestrator | null
  reload: () => Promise<void>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const kv = useKV()
  const notif = useNotifications()
  const [selectedId, setSelectedId] = createSignal<string | null>(
    props.tasks().some((t) => t.id === props.initialTaskId) ? props.initialTaskId! : (props.tasks()[0]?.id ?? null),
  )
  const [cursorId, setCursorId] = createSignal<string | null>(null)
  const actionTargetId = (): string | null => cursorId() ?? selectedId()

  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId() ?? "", tabId: "", title: message })
  }
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId() ?? "", tabId: "", title: message })
  }
  const [moveMode, setMoveMode] = createSignal(false)
  const [sortMode, setSortMode] = createSignal<TaskSortMode>(
    kv.get("activeSortMode") === "recent" ? "recent" : "default",
  )
  const persistedProjectFilter = kv.get("tasksPane.projectFilter")
  const [projectFilter, setProjectFilterSig] = createSignal<string | null>(
    typeof persistedProjectFilter === "string" && persistedProjectFilter.length > 0 ? persistedProjectFilter : null,
  )
  const setProjectFilter = (repo: string | null) => {
    setProjectFilterSig(repo)
    kv.set("tasksPane.projectFilter", repo)
  }
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)

  const [zenActive, setZenActive] = createSignal(false)
  {
    const pane = process.env.TMUX_PANE
    if (pane) {
      const pollZen = (): void => {
        void runTmuxCapturing(["show-options", "-wqv", "-t", pane, ZEN_HIDDEN_PANES_OPTION]).then(
          ({ code, stdout }) => {
            setZenActive(code === 0 && stdout.trim().length > 0)
          },
        )
      }
      pollZen()
      const zenTimer = setInterval(pollZen, 1000)
      onCleanup(() => clearInterval(zenTimer))
    }
  }

  const dimensions = useTerminalDimensions()

  createEffect(() => {
    if (props.initialTaskId) return
    const active = props.orch?.activeTaskSignal()()
    if (!active) return
    setSelectedId(active)
  })

  createEffect(
    on(
      () => props.orch?.uiPrefsSignal()(),
      (payload) => {
        if (payload && payload.sortMode !== untrack(sortMode)) setSortMode(payload.sortMode)
        if (payload && payload.projectFilter !== untrack(projectFilter)) setProjectFilterSig(payload.projectFilter)
      },
    ),
  )

  createEffect(() => {
    const info = props.orch?.updateSignal()()
    if (info) setUpdateInfo(info)
  })

  const actionsCtx: TasksHostActionsContext = {
    tasks: () => props.tasks(),
    orch: props.orch,
    kv,
    dialog,
    notifyError,
    notifyInfo,
    reload: () => props.reload(),
    updateInfo,
    setSelectedId,
  }
  const switchRef: SwitchToRef = { token: 0 }
  const switchTo = (id: string): Promise<void> => switchToAction(actionsCtx, switchRef, id)

  const taskActions: CreateTaskContext = buildTaskActionsContext({
    ...actionsCtx,
    selectedId,
    setSelectedId,
    switchTo,
  })

  async function createTask(): Promise<void> {
    await createTaskFlow(taskActions)
  }

  async function archiveTask(id: string): Promise<void> {
    await archiveTaskFlow(taskActions, id)
  }

  async function deleteTask(id: string): Promise<void> {
    await deleteTaskFlow(taskActions, id)
  }

  async function renameTask(id: string): Promise<void> {
    await renameTaskFlow(taskActions, id)
  }

  async function renameBranch(id: string): Promise<void> {
    await renameBranchFlow(taskActions, id)
  }

  async function cycleVendor(id: string): Promise<void> {
    await cycleVendorFlow(taskActions, id)
  }

  const openSettings = (): Promise<void> => openSettingsAction(actionsCtx)
  const openHelp = (): Promise<void> => openHelpAction(actionsCtx)
  const openWorktrees = (): Promise<void> => openWorktreesAction()
  const openUpdate = (): Promise<void> => openUpdateAction(actionsCtx)
  const openSelectedWorktree = (id: string): Promise<void> => openSelectedWorktreeAction(actionsCtx, id)
  const focusEnginePane = (): Promise<void> => focusEnginePaneAction()
  const moveTask = (id: string, delta: -1 | 1): Promise<void> => moveTaskAction(actionsCtx, id, delta)
  const togglePin = (id: string): Promise<void> => togglePinAction(actionsCtx, id)
  const togglePreviewFlow = (id: string): Promise<void> => togglePreviewFlowAction(actionsCtx, switchRef, id)

  const [keysCollapsed, setKeysCollapsedSig] = createSignal<boolean>(kv.get("tasksPane.keysCollapsed", false) === true)
  const setKeysCollapsed = (next: boolean) => {
    setKeysCollapsedSig(next)
    kv.set("tasksPane.keysCollapsed", next)
  }
  createEffect(
    on(
      () => props.orch?.uiPrefsSignal()(),
      (payload) => {
        if (payload && payload.keysCollapsed !== untrack(keysCollapsed)) setKeysCollapsedSig(payload.keysCollapsed)
      },
    ),
  )

  const [searchActive, setSearchActive] = createSignal(false)

  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !searchActive(),
    bindings: bindByIds({
      "help.open": () => void openHelp(),
      "task.new": () => void createTask(),
      "settings.open.sidebar": () => void openSettings(),
      "worktrees.open.sidebar": () => void openWorktrees(),
      "tasks.update": () => void openUpdate(),
      "tasks.openWorktree": () => {
        const id = actionTargetId()
        if (id) void openSelectedWorktree(id)
      },
      "tasks.renameBranch": () => {
        const id = actionTargetId()
        if (id) void renameBranch(id)
      },
      "tasks.cycleEngine": () => {
        const id = actionTargetId()
        if (id) void cycleVendor(id)
      },
      "tasks.toggleKeys": () => setKeysCollapsed(!keysCollapsed()),
      "tasks.focusEngine": () =>
        void focusEnginePane().catch((err) => console.error("[kobe tasks] focus engine pane failed:", err)),
    }),
  }))

  const headerStatus = createMemo(() => {
    const info = updateInfo()
    if (info?.hasUpdate) return { label: `v${info.latest} ↑`, emphasize: true }
    return { label: `v${CURRENT_VERSION}`, emphasize: false }
  })

  const daemonStale = (): boolean => props.orch?.daemonStaleSignal()() ?? false
  const daemonVersion = (): string | null => props.orch?.daemonVersionSignal()() ?? null

  const selectedIsMain = createMemo(() => props.tasks().find((t) => t.id === selectedId())?.kind === "main")

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <VersionSkewBanner
        stale={daemonStale}
        daemonVersion={daemonVersion}
        clientVersion={CURRENT_VERSION}
        width={() => dimensions().width}
      />
      <box flexGrow={1} flexShrink={1}>
        <Sidebar
          tasks={props.tasks}
          selectedId={selectedId}
          onSelect={props.initialTaskId ? () => {} : setSelectedId}
          pinnedSelection={!!props.initialTaskId}
          onActivate={(id) => void switchTo(id)}
          activateOnClick
          headerStatus={headerStatus}
          onHeaderStatusClick={() => void openUpdate()}
          onAddTask={() => void createTask()}
          zenActive={zenActive}
          onZenClick={() => {
            void (async () => {
              const session = await currentSessionName()
              if (session) await runLayoutAction(session, "zen-toggle")
            })()
          }}
          width={() => dimensions().width}
          engineState={props.orch ? props.orch.engineStateSignal() : undefined}
          taskJobs={props.orch ? props.orch.taskJobsSignal() : undefined}
          worktreeChanges={
            props.orch
              ? () => {
                  const orch = props.orch
                  if (!orch || orch.connectionStateSignal()() !== "online") return null
                  return orch.worktreeChangesSignal()()
                }
              : undefined
          }
          onRenameRequest={(id) => void renameTask(id)}
          onDeleteRequest={(id) => void deleteTask(id)}
          onArchiveRequest={(id) => void archiveTask(id)}
          onPinRequest={(id) => void togglePin(id)}
          onPreviewToggleRequest={(id) => void togglePreviewFlow(id)}
          onLocalMergeRequest={(id) => {
            const task = props.tasks().find((t) => t.id === id)
            if (!task || task.kind === "main") return
            setSelectedId(id)
            setMoveMode((cur) => !cur)
          }}
          moveMode={moveMode}
          onMoveRequest={(id, delta) => void moveTask(id, delta)}
          onMoveModeExit={() => setMoveMode(false)}
          sortMode={sortMode}
          projectFilter={projectFilter}
          onProjectFilterChange={setProjectFilter}
          onSortModeToggle={() => {
            const next: TaskSortMode = sortMode() === "default" ? "recent" : "default"
            setSortMode(next)
            kv.set("activeSortMode", next)
          }}
          focused={() => dialog.stack.length === 0}
          onSearchActiveChange={setSearchActive}
          onCursorChange={setCursorId}
        />
      </box>
      <ShortcutHints
        moveMode={moveMode}
        selectedIsMain={selectedIsMain}
        collapsed={keysCollapsed}
        onToggleCollapsed={() => setKeysCollapsed(!keysCollapsed())}
      />
    </box>
  )
}

export async function startTasksPane(opts: { initialTaskId?: string } = {}): Promise<void> {
  await bootPaneHost({
    logContext: "tasks",
    providers: { notifications: true },
    setup: () => setupTasksPane(opts),
  })
}
