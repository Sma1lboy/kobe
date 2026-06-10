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
 *
 * DEPRECATED DIRECTION: the outer monitor is now a transitional shell,
 * not the long-term primary workspace. The v0.6+ product direction is
 * inner-first: launching kobe should eventually hand over directly to
 * the tmux workspace when a target Task is known. Keep this shell only
 * for flows that still need an outer entry point (no Task yet, new/adopt
 * Task, settings, daemon recovery, and task selection) until those have
 * tmux-native homes.
 */

import { homedir } from "node:os"
import { render, useRenderer } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type Accessor, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../engine/interactive-command.ts"
import { deriveTitleFromSession } from "../monitor/auto-title.ts"
import { Orchestrator, PLACEHOLDER_TASK_TITLE } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, normalizeSavedRepos } from "../state/repos.ts"
import type { VendorId } from "../types/task.ts"
import type { UpdateInfo } from "../version.ts"
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
import { ThemeProvider, useTheme } from "./context/theme"
import { applyHostBootSteps, hostRenderOptions } from "./lib/host-boot"
import { useBindings } from "./lib/keymap"
import {
  type CreateTaskContext,
  archiveTaskFlow,
  createTaskFlow,
  deleteTaskFlow,
  renameTaskFlow,
  toggleTaskPinnedFlow,
} from "./lib/task-actions"
import { usePaneSizes } from "./lib/use-pane-sizes"
import { useThemePersistence } from "./lib/use-theme-persistence"
import { CostDashboard } from "./panes/monitor/CostDashboard"
import { LivePreview } from "./panes/monitor/LivePreview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import type { TaskSortMode } from "./panes/sidebar/groups"
import { ClaudeLauncher, type LaunchTaskTmuxResult, launchTaskTmux } from "./panes/terminal/fullscreen"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "claude"

type AppDeps = {
  orchestrator: KobeOrchestrator
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

  // Launch state is host-owned so BOTH enter paths (sidebar Enter and the
  // workspace launcher's own Enter) share one in-flight guard + one error
  // surface — the launcher renders `launchError` and gates on `launchRunning`.
  const [launchRunning, setLaunchRunning] = createSignal(false)
  const [launchError, setLaunchError] = createSignal<string | null>(null)

  // Follow the shared active-task focus: when a task is entered/switched
  // anywhere (this monitor or a tmux session's Tasks pane), the sidebar
  // selection tracks it, so coming back from a session you switched around
  // in lands the highlight on the task you were last in (KOB-247).
  createEffect(() => {
    const active = props.orchestrator.activeTaskSignal()()
    if (active !== null) setSelectedId(active)
  })

  // Sidebar bindings (Enter→enterTask, j/k, …) must go quiet while ANY
  // dialog is open: an input-based dialog (new-task / rename / settings'
  // command editor) submits via the native input's onSubmit, NOT a keymap
  // binding, so an un-gated Enter falls through the keymap to the Sidebar
  // and enters a task behind the dialog (KOB-244). Gate the Sidebar's
  // `focused` (which drives its bindings) on an empty dialog stack.
  const sidebarBindable = createMemo(() => isFocused("sidebar")() && dialog.stack.length === 0)

  function selectTask(id: string): void {
    setSelectedId(id)
    kv.set("lastSelectedTaskId", id)
  }

  /**
   * Enter the selected task's tmux session full-screen. Wired to:
   *   - The sidebar's `onActivate` (Enter on a row).
   *   - The ClaudeLauncher's own enter binding when the workspace
   *     pane already has focus.
   * Both paths converge here so a single keystroke ("press Enter
   * to open the task") is the user-visible contract — the user
   * never has to think about pane focus first.
   */
  async function enterTask(id: string): Promise<LaunchTaskTmuxResult> {
    // Single convergence point for BOTH entry bindings (sidebar onActivate
    // and the workspace launcher's own Enter). The host-owned launchRunning
    // guard makes a rapid double-Enter — even one that switches which pane
    // fires the chord — a no-op instead of racing a second launch (KOB-244).
    if (launchRunning()) return { kind: "ok", exitCode: null }
    setSelectedId(id)
    kv.set("lastSelectedTaskId", id)
    // Don't grab workspace focus on enter: the renderer suspends for the
    // attach (so outer focus is invisible meanwhile), and we land back on
    // the sidebar after detach. The sidebar (task pane) is the outer
    // monitor's home focus; the launcher still renders launchError
    // regardless of which pane is focused, so errors stay visible (KOB-244).
    const task = props.orchestrator.getTask(id)
    if (!task) return { kind: "error", message: "task not found" }
    // Publish the shared focus so EVERY surface (this monitor + each tmux
    // session's Tasks pane) highlights the same active task (KOB-247).
    void props.orchestrator.setActiveTask(id).catch(() => {})
    setLaunchRunning(true)
    setLaunchError(null)
    try {
      const res = await launchTaskTmux({
        renderer,
        taskId: id,
        cwd: task.worktreePath || null,
        command: interactiveEngineCommand(task.vendor),
        vendor: task.vendor,
        repo: task.repo,
        onEnsureWorktree: (taskId) => props.orchestrator.ensureWorktree(taskId),
      })
      if (res.kind === "error") {
        // Surface visibly — the workspace launcher renders launchError. A
        // bare console.error is invisible under the alternate-screen renderer.
        setLaunchError(res.message)
        console.error("[kobe] enterTask failed:", res.message)
        return res
      }
      // We're back in the outer monitor (the user hit Ctrl+Q to detach, or
      // the engine exited). Land focus on the sidebar task list, not the
      // workspace preview, so they can immediately pick / navigate tasks
      // (KOB-244).
      setFocused("sidebar")
      // Auto-name a still-unnamed task from its first prompt, now that the
      // user has interacted and the session transcript exists. One-shot:
      // only while the title is the placeholder, so a manual rename or a
      // prior auto-name is never overwritten. Best-effort — naming failure
      // must not break the return-from-handover path.
      const after = props.orchestrator.getTask(id)
      if (after && after.title === PLACEHOLDER_TASK_TITLE && after.worktreePath) {
        try {
          const title = await deriveTitleFromSession(after.worktreePath, after.vendor)
          if (title) await props.orchestrator.setTitle(id, title)
        } catch (err) {
          console.error("[kobe] auto-title failed:", err)
        }
      }
      return res
    } finally {
      setLaunchRunning(false)
    }
  }

  // Update info comes from the daemon-owned `update` channel (the daemon
  // polls npm once and fans it out) via the RemoteOrchestrator — the same
  // source the Tasks pane uses, so the outer monitor no longer hits the
  // registry itself. app.tsx always wires a RemoteOrchestrator; the guard
  // just keeps the KobeOrchestrator union type honest. Keep the last
  // non-null value so a later null poll (offline) doesn't drop the chip.
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  createEffect(() => {
    const orch = props.orchestrator
    if (orch instanceof RemoteOrchestrator) {
      const info = orch.updateSignal()()
      if (info) setUpdateInfo(info)
    }
  })

  // Pane sizes (sidebar width only in v0.6).
  const { sidebarWidth, setSidebarWidth, clampSidebar } = usePaneSizes(kv)

  // Re-entry guard: a second `q` / Ctrl+C while the confirm dialog is
  // already open would stack another dialog. Both chords route here.
  let quitConfirmOpen = false
  async function quit(): Promise<void> {
    if (quitConfirmOpen) return
    quitConfirmOpen = true
    const running = tasksAcc().filter((t) => t.status === "in_progress").length
    const message =
      running > 0
        ? `${running} task${running === 1 ? "" : "s"} still in progress. Their tmux sessions keep running after kobe exits.`
        : "Quit kobe?"
    let ok: boolean | undefined
    try {
      ok = await DialogConfirm.show(
        dialog,
        message,
        "Their work is persisted in tmux. Re-enter any time.",
        "stay",
        "quit",
      )
    } finally {
      quitConfirmOpen = false
    }
    if (ok !== true) return
    forceExit()
  }

  // Hard exit path — bypass the confirm prompt. Used after a confirmed
  // `quit()` and the detached `process.exit` callers. We destroy the
  // renderer first so the terminal isn't left in raw / alt-screen /
  // mouse-tracking mode.
  function forceExit(): void {
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    process.exit(0)
  }

  // Workspace view mode: "preview" (live capture-pane + ⏎ to enter)
  // or "dashboard" (cost table). Toggle with `d` when workspace focused
  // or `ctrl+d` globally. Defaults to preview so a fresh user sees
  // what their task is doing.
  const [view, setView] = createSignal<"preview" | "dashboard">("preview")
  const [taskSortMode, setTaskSortMode] = createSignal<TaskSortMode>("default")
  const toggleDashboard = (): void => {
    setView((v) => (v === "dashboard" ? "preview" : "dashboard"))
  }

  // Shared task-action context (lib/task-actions). The flows themselves —
  // confirm copy, DIRTY_WORKTREE force-delete branch, error handling — live
  // in the shared module so this deprecated shell and the Tasks pane can't
  // drift apart, and retiring app.tsx later is a deletion, not a port. What
  // stays here is only what's genuinely this host's: dialog wiring, kv
  // persistence, and selection. Divergences from the Tasks pane (no toasts,
  // no reload, no switch-before-kill — we're outside tmux) are expressed by
  // OMITTING the optional context members, not by separate flow copies.
  const taskActions: CreateTaskContext = {
    orch: props.orchestrator,
    tasks: () => tasksAcc(),
    confirm: async (p) => (await DialogConfirm.show(dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    promptText: (initial, opts) => RenameTaskDialog.show(dialog, initial, opts),
    logger: console,
    logPrefix: "[kobe]",
    // Drop selection if we just deleted the selected task. (This host
    // recomputes from the remaining list rather than using the flow's
    // nextTask — preserved pre-consolidation behavior.)
    onTaskDeleted: (taskId) => {
      if (selectedId() !== taskId) return
      const remaining = tasksAcc()
      const next = remaining.find((t) => !t.archived) ?? remaining[0]
      setSelectedId(next?.id ?? null)
    },
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(dialog, defaultRepo, repos, opts),
    // "Spawn a sibling" default: the active task's repo.
    cursorRepo: () => activeTask()?.repo,
    lastVendor: () => kv.get("lastSelectedVendor") as VendorId | undefined,
    rememberVendor: (vendor) => kv.set("lastSelectedVendor", vendor),
    // Mirror the fresh saved-repo list into the kv store so its debounced
    // whole-store flush doesn't clobber the disk write (savedRepos is not
    // otherwise a kv-managed key).
    onRepoSaved: () => kv.set("savedRepos", getSavedRepos()),
    selectTask,
  }

  // Sidebar callbacks — thin wrappers over the shared flows.
  async function newTask(): Promise<void> {
    await createTaskFlow(taskActions)
  }

  function openSettings(): void {
    void SettingsDialog.show(dialog, kv, props.orchestrator)
  }

  function openHelp(): void {
    HelpDialog.show(dialog)
  }

  async function archiveTask(taskId: string): Promise<void> {
    await archiveTaskFlow(taskActions, taskId)
  }

  async function renameTask(taskId: string): Promise<void> {
    await renameTaskFlow(taskActions, taskId)
  }

  async function pinTask(taskId: string): Promise<void> {
    await toggleTaskPinnedFlow({ orch: props.orchestrator, taskId, logger: console, logPrefix: "[kobe]" })
  }

  async function deleteTask(taskId: string): Promise<void> {
    await deleteTaskFlow(taskActions, taskId)
  }

  // Global keybindings — minimal in v0.6 (no chat composer, so most
  // chords moved with the chat pane). `q` quits, `n` new task,
  // `tab`/`shift+tab` cycle pane focus, `ctrl+1..2` jump to pane,
  // `ctrl+d` toggles cost dashboard.
  //
  // Gated on an empty dialog stack: while a modal (settings, new-task,
  // confirms) is open, NO app-level chord should fire behind it — the
  // dialog's own bindings sit on top of the keymap stack and handle what
  // they need; everything else must go quiet so a keypress can't leak to
  // a task action behind the dialog (KOB-244).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      // Ctrl+C asks for confirmation (same dialog as `q`) rather than
      // quitting outright — Jackson wants a guard against a fat-fingered
      // exit. The `quit()` re-entry guard makes a second Ctrl+C while
      // the dialog is open a no-op.
      { key: "ctrl+c", cmd: () => void quit() },
      { key: "ctrl+1", cmd: () => setFocused("sidebar") },
      { key: "ctrl+2", cmd: () => setFocused("workspace") },
      // h / l mirror the pane-header letters (sidebar=h, workspace=l).
      { key: "ctrl+h", cmd: () => setFocused("sidebar") },
      { key: "ctrl+l", cmd: () => setFocused("workspace") },
      { key: "ctrl+d", cmd: toggleDashboard },
      { key: "tab", cmd: () => cycleFocus(+1) },
      { key: "shift+tab", cmd: () => cycleFocus(-1) },
    ],
  }))

  // Sidebar-scoped letter chords. Gated on `sidebarBindable` (sidebar
  // focused AND no dialog open) — these are the task actions (n / d / a /
  // r / q / s) that must NOT fire when a dialog (e.g. settings) is open
  // over the sidebar, which would otherwise still count as "focused"
  // and leak the keypress into a task action behind the modal (KOB-244).
  useBindings(() => ({
    enabled: sidebarBindable(),
    bindings: [
      { key: "n", cmd: () => void newTask() },
      { key: "s", cmd: () => openSettings() },
      { key: "?", cmd: () => openHelp() },
      { key: "f1", cmd: () => openHelp() },
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
        {/* Sidebar — task list, status badges, search. The Sidebar
            renders its own `h TASKS` header internally, so we don't
            wrap it in a PaneHeader (that double-stacked the title). */}
        <box flexShrink={0} width={sidebarWidth()} flexDirection="column" onMouseUp={() => setFocused("sidebar")}>
          <Sidebar
            tasks={tasksAcc}
            selectedId={taskIdAcc}
            onSelect={selectTask}
            onActivate={(id) => void enterTask(id)}
            focused={sidebarBindable}
            onDeleteRequest={(id) => void deleteTask(id)}
            onArchiveRequest={(id) => void archiveTask(id)}
            onRenameRequest={(id) => void renameTask(id)}
            onPinRequest={(id) => void pinTask(id)}
            sortMode={taskSortMode}
            onSortModeToggle={() => setTaskSortMode((cur) => (cur === "default" ? "recent" : "default"))}
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
            ordinal="l"
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
                      focused={isFocused("workspace")}
                      running={launchRunning}
                      error={launchError}
                      onEnter={(id) => void enterTask(id)}
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
                  <Shell orchestrator={props.orchestrator} />
                </FocusProvider>
              </CommandPaletteProvider>
            </DialogProvider>
          </NotificationsProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

export async function startApp(): Promise<void> {
  // Partial adoption of `lib/host-boot`: the outer monitor shares the boot
  // steps + render options but NOT `bootPaneHost` — its theme is KV-persisted
  // via `useThemePersistence` (not `readPersistedUiPrefs`), and its provider
  // tree is different in kind (SyncProvider + CommandPaletteProvider, Dialog
  // OUTSIDE Focus). Molding the deprecated shell into the pane-host shape
  // would distort the shared module for everyone else.
  applyHostBootSteps()
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  let orchestrator: KobeOrchestrator
  if (process.env.KOBE_NO_DAEMON === "1") {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const worktrees = new GitWorktreeManager()
    orchestrator = new Orchestrator({ store, worktrees })
  } else {
    const client = await connectOrStartDaemon()
    // role: "gui" — the outer monitor is a front-end attach, so it holds the
    // daemon alive (like direct.ts). In-tmux panes subscribe as "pane".
    orchestrator = new RemoteOrchestrator(client, { role: "gui" })
    // Propagate the daemon's socket so every in-session client connects to
    // the SAME daemon. The tmux server + all panes (Tasks pane, quick-create,
    // ops) inherit this env, so a task created / renamed / re-vendored from
    // inside a session lands on the daemon the outer monitor subscribes to —
    // keeping all panels in sync (KOB-233).
    process.env.KOBE_DAEMON_SOCKET_PATH = client.socketPath
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
  await render(() => <App orchestrator={orchestrator} />, hostRenderOptions())
}
