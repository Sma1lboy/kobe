/**
 * kobe application shell (v0.6).
 *
 * Layout: TopBar + Sidebar | ClaudeLauncher + StatusBar.
 *
 * v0.5 hosted a 5-pane workspace (sidebar / chat / files / preview /
 * terminal) driven by a headless `claude -p` engine. v0.6 collapses
 * the workspace to a single full-pane ClaudeLauncher — pressing ⏎
 * hands the terminal over to a tmux session that the engine
 * (claude / codex) runs natively. Step B (KOB-228) extends the tmux
 * session to a pre-split three-pane layout (claude / Ops / shell);
 * Step C (KOB-229) ships the Ops pane tool; Step D (KOB-230) brings
 * a live preview rail + cost dashboard back into the outer monitor.
 */

import { homedir } from "node:os"
import { render, useRenderer } from "@opentui/solid"
import { type Accessor, Show, createMemo, createSignal, onMount } from "solid-js"
import {
  connectOrStartDaemon,
  connectOrStartOwnedDaemon,
  ensureOwnedDaemonReachable,
} from "../client/daemon-process.ts"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { type TuiDaemonMode, resolveDaemonMode } from "../daemon/mode.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, normalizeSavedRepos } from "../state/repos.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { HelpDialog } from "./component/help-dialog"
import { NewTaskDialog } from "./component/new-task-dialog"
import { PaneHeader } from "./component/pane-header"
import { RenameTaskDialog } from "./component/rename-task-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { SettingsDialog } from "./component/settings-dialog"
import { StatusBar } from "./component/status-bar"
import { ToastOverlay } from "./component/toast-overlay"
import { TopBar } from "./component/top-bar"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { KVProvider, useKV } from "./context/kv"
import { NotificationsProvider } from "./context/notifications"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, addTheme, useTheme } from "./context/theme"
import { loadUserThemes } from "./context/theme/loader"
import { useBindings } from "./lib/keymap"
import { usePaneSizes } from "./lib/use-pane-sizes"
import { useThemePersistence } from "./lib/use-theme-persistence"
import { CostDashboard } from "./panes/monitor/CostDashboard"
import { LivePreview } from "./panes/monitor/LivePreview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { ClaudeLauncher } from "./panes/terminal/fullscreen"
import { killSession, tmuxSessionName } from "./panes/terminal/tmux"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "claude"

// The chat pane handed off to a tmux session running this argv. Step B
// (KOB-228) extends the session to a three-pane split; the bare `claude`
// command lives in pane 0.
const CHAT_CLAUDE_COMMAND: readonly string[] = ["claude"]

type AppDeps = {
  orchestrator: KobeOrchestrator
  onQuit?: () => Promise<void>
}

function Shell(props: AppDeps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()
  const { setFocused, focused: focusedPane, is: isFocused } = useFocus()
  const renderer = useRenderer()

  useThemePersistence(themeCtx, kv)

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()

  const persistedSelectedId = kv.get("lastSelectedTaskId") as string | null | undefined
  const [selectedId, setSelectedId] = createSignal<string | null>(persistedSelectedId ?? null)

  // Validate the persisted selection against the live list. If the task
  // was deleted, fall back to the first non-archived task.
  onMount(() => {
    const all = tasksAcc()
    const persisted = selectedId()
    if (persisted && all.some((t) => t.id === persisted)) return
    const first = all.find((t) => !t.archived) ?? all[0]
    if (first) {
      setSelectedId(first.id)
      kv.set("lastSelectedTaskId", first.id)
    }
  })

  const activeTask = createMemo(() => {
    const id = selectedId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })

  const taskIdAcc = createMemo<string | null>(() => selectedId())
  const worktreePathAcc = createMemo<string | null>(() => activeTask()?.worktreePath || null)

  function selectTask(id: string): void {
    setSelectedId(id)
    kv.set("lastSelectedTaskId", id)
  }

  // Background npm-registry check — best-effort, no spinner.
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  onMount(() => {
    void checkLatestVersion()
      .then((info) => {
        if (info) setUpdateInfo(info)
      })
      .catch(() => {})
  })

  // Pane sizes (sidebar width only in v0.6).
  const { sidebarWidth, setSidebarWidth, clampSidebar } = usePaneSizes(kv)

  async function quit(): Promise<void> {
    const running = tasksAcc().filter((t) => t.status === "in_progress").length
    const message =
      running > 0
        ? `${running} task${running === 1 ? "" : "s"} still in progress. Their tmux sessions keep running after kobe exits.`
        : "Quit kobe?"
    const ok = await DialogConfirm.show(
      dialog,
      message,
      "Their work is persisted in tmux. Re-enter any time.",
      "stay",
      "quit",
    )
    if (ok !== true) return
    forceExit()
  }

  // Hard exit path — bypass the confirm prompt. Used by Ctrl+C and the
  // detached `process.exit` callers. We destroy the renderer first so
  // the terminal isn't left in raw / alt-screen / mouse-tracking mode.
  function forceExit(): void {
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    void props.onQuit?.().catch(() => {})
    process.exit(0)
  }

  // Workspace view mode: "preview" (live capture-pane + ⏎ to enter)
  // or "dashboard" (cost table). Toggle with `d` when workspace focused
  // or `ctrl+d` globally. Defaults to preview so a fresh user sees
  // what their task is doing.
  const [view, setView] = createSignal<"preview" | "dashboard">("preview")
  const toggleDashboard = (): void => {
    setView((v) => (v === "dashboard" ? "preview" : "dashboard"))
  }

  // Sidebar callbacks.
  async function newTask(): Promise<void> {
    const repos = getSavedRepos()
    if (repos.length === 0) {
      await DialogConfirm.show(
        dialog,
        "No saved repos.",
        "Run `kobe add <path>` from a shell first to register a repo, then come back here.",
        "",
        "ok",
      )
      return
    }
    // Default to the active task's repo when one is selected so the
    // common "spawn a sibling" flow doesn't make the user re-pick.
    const defaultRepo = activeTask()?.repo ?? repos[0] ?? ""
    const result = await NewTaskDialog.show(dialog, { repos, defaultRepo })
    if (!result) return
    const task = await props.orchestrator.createTask(result)
    selectTask(task.id)
  }

  async function openSettings(): Promise<void> {
    await SettingsDialog.show(dialog)
  }

  async function openHelp(): Promise<void> {
    await HelpDialog.show(dialog)
  }

  async function archiveTask(taskId: string): Promise<void> {
    await props.orchestrator.setArchived(taskId).catch((err: unknown) => {
      console.error("[kobe] archive failed:", err)
    })
  }

  async function renameTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const next = await RenameTaskDialog.show(dialog, task.title)
    if (!next) return
    await props.orchestrator.setTitle(taskId, next).catch((err: unknown) => {
      console.error("[kobe] rename failed:", err)
    })
  }

  async function pinTask(taskId: string): Promise<void> {
    await props.orchestrator.setPinned(taskId).catch((err: unknown) => {
      console.error("[kobe] pin failed:", err)
    })
  }

  async function deleteTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const ok = await DialogConfirm.show(
      dialog,
      `Delete "${task.title}"?`,
      "Removes the task entry and its worktree. The tmux session (if any) is killed.",
      "cancel",
      "delete",
    )
    if (ok !== true) return
    await props.orchestrator.deleteTask(taskId).catch((err: unknown) => {
      console.error("[kobe] delete failed:", err)
    })
    // Tear down the tmux session for this task so a re-created task
    // with the same id (theoretically possible across kobe restarts
    // if the user crafted a manifest) doesn't attach into the dead
    // task's stale claude pane.
    await killSession(tmuxSessionName(taskId)).catch((err: unknown) => {
      console.error("[kobe] kill tmux session failed:", err)
    })
    // Drop selection if we just deleted the selected task.
    if (selectedId() === taskId) {
      const remaining = tasksAcc()
      const next = remaining.find((t) => !t.archived) ?? remaining[0]
      setSelectedId(next?.id ?? null)
    }
  }

  // Global keybindings — minimal in v0.6 (no chat composer, so most
  // chords moved with the chat pane). `q` quits, `n` new task,
  // `tab`/`shift+tab` cycle pane focus, `ctrl+1..2` jump to pane,
  // `ctrl+d` toggles cost dashboard.
  useBindings(() => ({
    enabled: true,
    bindings: [
      // Force-exit on Ctrl+C — the v0.5 two-press-to-quit chord came
      // with a wider keymap stack we tore down. Single-press immediate
      // exit is fine for v0.6: every task's work is persisted in tmux,
      // so Ctrl+C never loses anything.
      { key: "ctrl+c", cmd: forceExit },
      { key: "ctrl+1", cmd: () => setFocused("sidebar") },
      { key: "ctrl+2", cmd: () => setFocused("workspace") },
      { key: "ctrl+d", cmd: toggleDashboard },
      { key: "tab", cmd: () => cycleFocus(+1) },
      { key: "shift+tab", cmd: () => cycleFocus(-1) },
    ],
  }))

  // Sidebar-scoped letter chords.
  useBindings(() => ({
    enabled: isFocused("sidebar")(),
    bindings: [
      { key: "n", cmd: () => void newTask() },
      { key: "s", cmd: () => void openSettings() },
      { key: "?", cmd: () => void openHelp() },
      { key: "f1", cmd: () => void openHelp() },
      { key: "q", cmd: () => void quit() },
      {
        key: "d",
        cmd: () => {
          const id = selectedId()
          if (id) void deleteTask(id)
        },
      },
      {
        key: "a",
        cmd: () => {
          const id = selectedId()
          if (id) void archiveTask(id)
        },
      },
      {
        key: "r",
        cmd: () => {
          const id = selectedId()
          if (id) void renameTask(id)
        },
      },
      { key: "d", cmd: toggleDashboard },
    ],
  }))

  function cycleFocus(direction: 1 | -1): void {
    const order: PaneId[] = ["sidebar", "workspace"]
    const current = focusedPane()
    const idx = order.indexOf(current)
    const next = order[(idx + direction + order.length) % order.length] ?? "sidebar"
    setFocused(next)
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar orchestrator={props.orchestrator} activeTask={activeTask} updateInfo={updateInfo} />
      <box flexDirection="row" flexGrow={1}>
        {/* Sidebar — task list, status badges, search. */}
        <box flexShrink={0} width={sidebarWidth()} flexDirection="column" onMouseUp={() => setFocused("sidebar")}>
          <PaneHeader title="TASKS" ordinal="j" focused={focusedPane() === "sidebar"} />
          <Sidebar
            tasks={tasksAcc}
            selectedId={taskIdAcc}
            onSelect={selectTask}
            focused={isFocused("sidebar")}
            onDeleteRequest={(id) => void deleteTask(id)}
            onArchiveRequest={(id) => void archiveTask(id)}
            onRenameRequest={(id) => void renameTask(id)}
            onPinRequest={(id) => void pinTask(id)}
            onAddTask={() => void newTask()}
            width={sidebarWidth}
          />
        </box>
        <ResizableEdge
          orientation="vertical"
          size={sidebarWidth}
          setSize={setSidebarWidth}
          clamp={clampSidebar}
          focused={isFocused("sidebar")}
        />
        {/* Workspace — single full pane for the ClaudeLauncher. */}
        <box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          onMouseUp={() => setFocused("workspace")}
          backgroundColor={theme.background}
        >
          <PaneHeader
            title={view() === "dashboard" ? "COST DASHBOARD" : "WORKSPACE"}
            ordinal="k"
            focused={focusedPane() === "workspace"}
          />
          <Show
            when={view() === "dashboard"}
            fallback={
              <Show
                when={activeTask()}
                fallback={
                  <box flexGrow={1} alignItems="center" justifyContent="center">
                    <text fg={theme.textMuted}>No task selected — press `n` in the sidebar to create one.</text>
                  </box>
                }
              >
                {/* Top half: live capture-pane preview of the selected
                  task's claude session. Bottom: the launcher with the
                  ⏎ hint. The split is 70/30 — preview is the focus,
                  launcher is a thin foot. */}
                <box flexDirection="column" flexGrow={1}>
                  <box flexGrow={7} flexShrink={1} flexBasis={0}>
                    <LivePreview taskId={taskIdAcc} />
                  </box>
                  <box flexShrink={0} paddingTop={1} paddingBottom={1}>
                    <ClaudeLauncher
                      taskId={taskIdAcc}
                      cwd={worktreePathAcc}
                      command={CHAT_CLAUDE_COMMAND}
                      focused={isFocused("workspace")}
                      onEnsureWorktree={async (id) => props.orchestrator.ensureWorktree(id)}
                    />
                  </box>
                </box>
              </Show>
            }
          >
            <CostDashboard tasks={tasksAcc} />
          </Show>
        </box>
      </box>
      <StatusBar />
      <ToastOverlay />
    </box>
  )
}

function App(props: AppDeps) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <SyncProvider>
          <NotificationsProvider>
            <DialogProvider>
              <CommandPaletteProvider>
                <FocusProvider initial="sidebar">
                  <Shell orchestrator={props.orchestrator} onQuit={props.onQuit} />
                </FocusProvider>
              </CommandPaletteProvider>
            </DialogProvider>
          </NotificationsProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

export async function startApp(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  let orchestrator: KobeOrchestrator
  let stopOwnedDaemon: (() => Promise<void>) | undefined
  let ownedDaemonStopped = false
  const stopOwnedDaemonOnce = async (): Promise<void> => {
    if (ownedDaemonStopped) return
    ownedDaemonStopped = true
    await stopOwnedDaemon?.()
  }
  if (process.env.KOBE_NO_DAEMON === "1") {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const worktrees = new GitWorktreeManager()
    orchestrator = new Orchestrator({ store, worktrees })
  } else {
    const daemonMode = resolveDaemonMode(options.daemonMode)
    if (daemonMode === "shared") {
      orchestrator = new RemoteOrchestrator(await connectOrStartDaemon())
    } else {
      const owned = await connectOrStartOwnedDaemon()
      stopOwnedDaemon = owned.stop
      orchestrator = new RemoteOrchestrator(owned.client, {
        ensureReachable: () => ensureOwnedDaemonReachable(owned.socketPath, owned.pidPath),
      })
    }
    await orchestrator.init()
  }
  normalizeSavedRepos()
  for (const repo of getSavedRepos()) {
    try {
      await orchestrator.ensureMainTask(repo)
    } catch (err) {
      console.error(`[kobe] ensureMainTask failed for ${repo}:`, err)
    }
  }
  await render(() => <App orchestrator={orchestrator} onQuit={stopOwnedDaemonOnce} />, {
    backgroundColor: "transparent",
    externalOutputMode: "passthrough",
    exitOnCtrlC: false,
    onDestroy: () => {
      void stopOwnedDaemonOnce().catch(() => {})
    },
    screenMode: "alternate-screen",
    useKittyKeyboard: {},
  })
}
