/**
 * kobe application shell — full 5-pane Wave 3 layout.
 *
 * Layout (left → right): Sidebar | Chat | RightColumn{ FileTree, Preview, Terminal }
 *
 * Wiring:
 *   - Active task is selected in Sidebar (Stream F) and propagates a
 *     `selectedId` Solid signal that drives every other pane.
 *   - `worktreePath` is derived from the active task and feeds FileTree
 *     (Stream H), Preview (Stream I), and Terminal (Stream J).
 *   - FileTree's `onOpenFile` calls into Preview's imperative API, captured
 *     once via the `onOpen` callback.
 *   - Terminal owns one pty per task (resolved Wave 1 decision §5).
 *
 * Engine selection:
 *   - Default: `ClaudeCodeLocal` (subprocess wrapper around `claude` CLI).
 *   - With `KOBE_TEST_ENGINE=fake`: in-process `FakeAIEngine` plus a tiny
 *     HTTP side-channel on `KOBE_TEST_FAKE_PORT` for behavior tests to
 *     script events. The test pre-allocates the port and POSTs JSON to
 *     `/script` and `/finish`. Production never sets the env vars.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { render, useRenderer } from "@opentui/solid"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import {
  connectOrStartDaemon,
  connectOrStartOwnedDaemon,
  ensureOwnedDaemonReachable,
} from "../client/daemon-process.ts"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { type TuiDaemonMode, resolveDaemonMode } from "../daemon/mode.ts"
import { Orchestrator, chatRunStateKey } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { NullMetadataSuggester } from "../orchestrator/metadata-suggester.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, normalizeSavedRepos } from "../state/repos.ts"
import type { ChatTab } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { useAppKeymap } from "./app-keymap"
import { BackgroundTasksDialog } from "./component/background-tasks-dialog"
import { BackgroundTasksIndicator } from "./component/background-tasks-indicator"
import { computeBackgroundRows } from "./component/background-tasks-parts"
import { CenterTabStrip } from "./component/center-tab-strip"
import { HelpDialog } from "./component/help-dialog"
import { PaneHeader } from "./component/pane-header"
import { RcBridgeDialog } from "./component/rc-bridge-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { StatusBar } from "./component/status-bar"
import { ToastOverlay } from "./component/toast-overlay"
import { TopBar } from "./component/top-bar"
import { CommandPaletteProvider, useCommandPalette } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider, useKV } from "./context/kv"
import { NotificationsProvider, useNotifications } from "./context/notifications"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, addTheme, useTheme } from "./context/theme"
import { loadUserThemes } from "./context/theme/loader"
import { buildEngines } from "./engine-bootstrap"
import { formatPlanUsageCompact } from "./lib/format-plan-usage"
import { useCompletionNotifications } from "./lib/use-completion-notifications"
import { usePaneSizes } from "./lib/use-pane-sizes"
import { useTaskActions } from "./lib/use-task-actions"
import { useTestSideChannel } from "./lib/use-test-side-channel"
import { useThemePersistence } from "./lib/use-theme-persistence"
import { useWorkspaceTabs } from "./lib/use-workspace-tabs"
import { detectWorktreeOpener, openWorktree } from "./lib/worktree-opener"
import { Chat } from "./panes/chat/Chat"
import { bootstrapHistory } from "./panes/chat/composer/history"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "claude"

// Engine selection + fake-engine HTTP side-channel moved to
// `./engine-bootstrap.ts`. The side-channel is test-only — production
// builds never set `KOBE_TEST_ENGINE` / `KOBE_TEST_FAKE_PORT`.

// New-task dialog lives in `./component/new-task-dialog/` — see that
// module for the state machine (state.ts), the JSX shell (dialog.tsx),
// and the `NewTaskDialog.show(...)` entry point. Imported above.
//
// Rename-task dialog lives in `./component/rename-task-dialog/` and
// shares `stripNewlines` with the new-task dialog (opentui's `<input>`
// quirk that inserts a literal `\n` on Enter).

/* --------------------------------------------------------------------- */
/*  Top-level Shell                                                       */
/* --------------------------------------------------------------------- */

export type AppDeps = {
  orchestrator: KobeOrchestrator
  onQuit?: () => Promise<void>
}

// PaneHeader / StatusBar / TopBar moved to `./component/*.tsx` — they
// are pure rendering and don't share state with Shell. The `Hotkey`
// chip helper moved alongside StatusBar (it's only used there).

function Shell(props: AppDeps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()
  const notifications = useNotifications()

  // Theme / KV round-trip — hydrate once on mount, then mirror every
  // change back. See `./lib/use-theme-persistence.ts` for the three
  // round-trips (activeTheme, transparentBackground, focusAccent) and
  // why the hydrate has to happen here rather than inside ThemeProvider.
  useThemePersistence(themeCtx, kv)

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()
  // Live per-task engine state (running / awaiting_input / idle) for
  // the sidebar status dot. Reactive — bumps whenever a task's tab
  // starts, finishes, or pauses on AskUserQuestion / ExitPlanMode.
  const chatRunStateAcc = props.orchestrator.chatRunStateSignal()
  // Persisted across runs in `~/.config/kobe/state.json` via the KV store
  // so reopening kobe lands on the task + center tab the user left from.
  // The auto-select effect below validates the persisted id against the
  // current task list (it may have been deleted between runs) and falls
  // back to tasks[0] when stale.
  const persistedSelectedId = kv.get("lastSelectedTaskId") as string | null | undefined
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  // Set by the new-task flow so the chat pane auto-submits the
  // prompt the user typed in the dialog. The chat clears it on
  // consumption to avoid re-submission on resubscribe.
  const [pendingPrompt, setPendingPrompt] = createSignal<{ taskId: string; prompt: string } | null>(null)
  /** Workspace header context meter (`12% · 24k/200k`), fed by the active chat tab. */
  const [workspaceContextAside, setWorkspaceContextAside] = createSignal<string | null>(null)
  // Claude plan utilization, fed by the daemon's plan-usage poller.
  // Independent of the active tab — surfaces in the workspace header
  // even when no chat is open. The combined memo lives further down,
  // after `isChatTabActive` is destructured from `useWorkspaceTabs`.
  const planUsageAcc = props.orchestrator.planUsageSignal()
  const workspacePlanAside = createMemo(() => formatPlanUsageCompact(planUsageAcc()))

  // Remote-control bridge (KOB-62) — accessor declared up here so
  // anyone above-the-fold (TopBar) can read it. The palette command
  // that opens the dialog is registered further down in Shell, after
  // `activeTask` / `activeChatTabIdAcc` exist — the dialog binds the
  // bridge to the focused tab so claude.ai sees the right worktree.
  const rcBridgeAcc = props.orchestrator.rcBridgeSignal()

  // Background npm-registry version check. Runs on every TUI launch so
  // freshly published versions show up in the topbar immediately. The
  // request has a 3s timeout; failures are silent, the chip just doesn't render.
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  onMount(() => {
    void checkLatestVersion()
      .then((info) => {
        if (info) setUpdateInfo(info)
      })
      .catch(() => {
        /* swallow — version check is best-effort */
      })
  })

  const activeTask = createMemo(() => {
    const id = selectedId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })
  const worktreeOpener = createMemo(() => detectWorktreeOpener())
  function openActiveTaskInEditor(): void {
    const task = activeTask()
    const opener = worktreeOpener()
    if (!task?.worktreePath || !opener) return
    if (!openWorktree(task.worktreePath, opener)) {
      // eslint-disable-next-line no-console
      console.error("[kobe] failed to open worktree:", task.worktreePath)
    }
  }

  // Accessor for the chat pane that yields a prompt only when it
  // matches the currently active task. This keeps the chat from
  // auto-submitting a leftover prompt against the wrong task after
  // a switch.
  const taskIdAcc = createMemo(() => selectedId() ?? undefined)
  createEffect(
    on(taskIdAcc, () => {
      setWorkspaceContextAside(null)
    }),
  )
  const activeTitleAcc = createMemo(() => activeTask()?.title)
  const pendingPromptForActive = createMemo(() => {
    const pp = pendingPrompt()
    if (!pp) return undefined
    if (pp.taskId !== selectedId()) return undefined
    return pp.prompt
  })
  // Per-task accessors for the right-column panes. FileTree + Preview key
  // off `worktreePath`; Terminal keys off both `cwd` and `taskId` (so the
  // pty registry can deduplicate per task per the resolved Wave-1 decision).
  //
  // Empty string is normalised to null: orchestrator.createTask publishes
  // a transient placeholder task with worktreePath="" before the worktree
  // is actually written to disk. Treating "" as a real path would call
  // `git ls-files` with cwd="" and crash. The placeholder window is short
  // (one git worktree add) but the subscribers see it.
  const worktreePathAcc = createMemo<string | null>(() => {
    const path = activeTask()?.worktreePath
    return path ? path : null
  })
  const taskIdNullAcc = createMemo<string | null>(() => selectedId())
  // Diff base — for v1, just compare against HEAD (working-tree changes).
  // Wave 4 polish makes this configurable per-task (e.g. branch fork point).
  const diffBaseAcc = createMemo<string | null>(() => (worktreePathAcc() ? "HEAD" : null))

  // FileTree → Preview wiring: capture Preview's imperative API once,
  // then route file-tree clicks/enters into Preview.open(). Plus the
  // outer center-column tab state below tracks which file tab is active.
  const [previewApi, setPreviewApi] = createSignal<PreviewApi | null>(null)

  /* ------------------------------------------------------------------- */
  /*  Pane sizing — three <ResizableEdge /> splitters + keyboard nudger   */
  /* ------------------------------------------------------------------- */
  // All size signals, KV round-trip, and the clamp helpers live in
  // `./lib/use-pane-sizes.ts`. The hook also owns the keyboard-resize
  // `nudge(delta, focused)` that we thread into the app-keymap below.
  const paneSizes = usePaneSizes(kv)
  const { sidebarWidth, setSidebarWidth, workspaceWidth, setWorkspaceWidth, filesHeight, setFilesHeight } = paneSizes
  const { clampSidebar, clampWorkspace, clampFiles } = paneSizes

  /* ------------------------------------------------------------------- */
  /*  Pane focus — backed by FocusContext (src/tui/context/focus.tsx)     */
  /* ------------------------------------------------------------------- */
  const focus = useFocus()
  const focusedPane = focus.focused
  const setFocusedPane = focus.setFocused
  // Renderer handle — only used by the quit-confirm path so we can
  // tear down opentui state (mouse tracking, alt-screen, raw mode)
  // before process.exit. Without this the parent shell sees mouse
  // escape sequences leaking past kobe's exit.
  const renderer = useRenderer()
  let quitting = false
  const quit = () => {
    if (quitting) return
    quitting = true
    try {
      renderer?.destroy()
    } catch (err) {
      console.error("kobe: renderer.destroy() failed during quit:", err)
    }
    const forceExit = setTimeout(() => process.exit(0), 1500)
    forceExit.unref()
    void (props.onQuit?.() ?? Promise.resolve()).finally(() => {
      clearTimeout(forceExit)
      process.exit(0)
    })
  }
  // Pane-bindings-active accessor: true only when (a) the pane is the
  // focused one AND (b) no dialog is open. The dialog gate prevents
  // sidebar/files/terminal bindings from firing while the user is
  // typing into a dialog input — `d` typed into a path field would
  // otherwise trigger the sidebar's delete-task confirmation.
  const isFocused = (pane: PaneId): Accessor<boolean> => {
    const baseAcc = focus.is(pane)
    return () => baseAcc() && dialog.stack.length === 0
  }

  /* ------------------------------------------------------------------- */
  /*  Daemon disconnect modal (KOB-38)                                    */
  /* ------------------------------------------------------------------- */
  // When the daemon socket drops, RemoteOrchestrator flips
  // `connectionState` to `"disconnected"`. We pop a modal letting the
  // user pick Restart (spawn `kobe daemon start` + reconnect) or Quit (process.exit).
  // Esc on the modal counts as Quit — daemon-less kobe is useless so
  // dismissing the prompt would just leave the user stranded.
  // In-process Orchestrator (KOBE_NO_DAEMON) has no socket and stays
  // `"online"` forever, so the effect is a no-op there.
  let showingDisconnectDialog = false
  async function showDisconnectDialog(): Promise<void> {
    const orch = props.orchestrator
    if (!(orch instanceof RemoteOrchestrator)) return
    let message = "The kobe daemon is no longer reachable. Restart it and reconnect, or quit kobe?"
    while (true) {
      const choice = await DialogConfirm.show(dialog, "daemon disconnected", message, "Quit", "Restart")
      if (choice !== true) {
        quit()
      }
      try {
        await orch.manualReconnect()
        return
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        message = `Restart failed: ${errMsg}\n\nTry again or quit?`
      }
    }
  }
  createEffect(() => {
    const orch = props.orchestrator
    if (!(orch instanceof RemoteOrchestrator)) return
    if (orch.connectionStateSignal()() !== "disconnected") return
    if (showingDisconnectDialog) return
    showingDisconnectDialog = true
    void showDisconnectDialog().finally(() => {
      showingDisconnectDialog = false
    })
  })

  // ctrl+hjkl pane focus. h/j/k/l → sidebar / workspace / files /
  // terminal (ordinal 1/2/3/4 mapped onto the vim row). ctrl+letter
  // chords have stable C0 control byte mappings, so they work in
  // every terminal + tmux config without CSI-u / kitty keyboard /
  // per-user setup. The handler reads `evt.name` to dispatch.
  const FOCUS_HJKL_TARGETS: Record<string, PaneId> = {
    h: "sidebar",
    j: "workspace",
    k: "files",
    l: "terminal",
  }

  // Keyboard-resize step. The grow/shrink direction comes from the
  // chord; the per-pane nudge logic lives in `paneSizes.nudge`.
  const RESIZE_STEP = 2
  const nudgeFocusedPane = (delta: number): void => paneSizes.nudge(delta, focusedPane())
  // Note: the actual `useBindings(...)` calls for focus.numeric and
  // pane.resize live in `useAppKeymap(...)` below — see app-keymap.tsx
  // for the full priority stack.

  // Tab / shift+tab pane cycling is registered via `useKobeKeybindings`'s
  // onFocusNext / onFocusPrev callbacks below — we just gate them here
  // (no-op when workspace is focused so opentui's textareas can claim
  // tab for their own intra-input behavior).

  /* ------------------------------------------------------------------- */
  /*  Center-column tab state — per-task                                  */
  /* ------------------------------------------------------------------- */
  // Workspace tab strategy lives in `./lib/use-workspace-tabs.ts` — see
  // that hook for the KOB-20 single-file-tab rule, the chat-multitab
  // chip wiring, and the per-task persistence effect.
  const workspaceTabs = useWorkspaceTabs({
    orchestrator: props.orchestrator,
    kv,
    selectedId,
    activeTask,
    previewApi,
    setFocusedPane,
  })
  const {
    isChatTabActive,
    activeFileTabPath,
    activeChatTabsAcc,
    activeChatTabIdAcc,
    openFileInCenter,
    selectChatTab,
    selectChatTabById,
    selectFileTab,
    closeFileTab,
  } = workspaceTabs

  // Workspace header right-side chip: plan utilization always (when
  // available) joined to the context meter when a chat tab is active.
  // Defined here because the join depends on `isChatTabActive`, which
  // only exists after the destructure above.
  const workspaceAsideRight = createMemo<string | undefined>(() => {
    const plan = workspacePlanAside()
    const ctx = isChatTabActive() ? workspaceContextAside() : null
    const parts = [plan, ctx].filter((v): v is string => Boolean(v))
    if (parts.length === 0) return undefined
    return parts.join("  •  ")
  })

  // Register the remote-control share command in the palette. Daemon-only —
  // the in-process Orchestrator stub returns "off" forever, so even if a
  // test somehow invoked the command it would be a no-op. The dialog
  // binds to whichever task + chat tab is focused at the moment of
  // invocation; switching focus later doesn't reassign a running bridge.
  const palette = useCommandPalette()
  onMount(() => {
    if (!(props.orchestrator instanceof RemoteOrchestrator)) return
    const orch = props.orchestrator
    const unregister = palette.addCommand({
      name: "rcBridge.share",
      title: "Share to claude.ai (remote-control)",
      desc: "Bind this task's worktree to a claude.ai environment so you can resume the conversation from another device.",
      slashName: "share",
      run: () => RcBridgeDialog.show(dialog, orch, rcBridgeAcc, activeTask, activeChatTabIdAcc),
    })
    onCleanup(unregister)
  })
  onMount(() => {
    const unregister = palette.addCommand({
      name: "task.openEditor",
      title: "Open task in editor",
      desc: "Open the active task worktree in Cursor, VS Code, or the detected system editor.",
      run: openActiveTaskInEditor,
    })
    onCleanup(unregister)
  })

  // Auto-select on first task availability. Prefer the persisted task
  // from the previous run when it still exists; otherwise fall back to
  // tasks[0]. The `persistedSelectedId` reference is consumed exactly
  // once (we null it after the first successful match) so user-driven
  // selections later in the session aren't snapped back.
  let pendingPersistedId: string | null = persistedSelectedId ?? null
  createEffect(() => {
    const tasks = tasksAcc()
    if (selectedId()) return
    if (tasks.length === 0) return
    const persisted = pendingPersistedId ? tasks.find((t) => t.id === pendingPersistedId) : undefined
    pendingPersistedId = null
    setSelectedId((persisted ?? tasks[0])!.id)
  })

  // Persist the active task whenever it changes. The KV store debounces
  // writes internally so this is cheap. (Per-task tab state is persisted
  // inside `useWorkspaceTabs`.)
  createEffect(() => {
    kv.set("lastSelectedTaskId", selectedId())
  })

  // Saved repos — populated by the `kobe add [path]` CLI subcommand
  // (src/cli/index.ts), read here for the new-task dialog's repo
  // picker. Reading through a memo over kv.store keeps the picker
  // reactive on the same kobe instance. Defensive filter in case the
  // on-disk file was hand-edited to a non-array.
  const savedRepos = createMemo<readonly string[]>(() => {
    const raw = kv.get("savedRepos", [])
    if (!Array.isArray(raw)) return []
    return raw.filter((s): s is string => typeof s === "string")
  })

  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
    // Tab cycle is no-op while workspace is focused so the composer's
    // own tab handling (dialog field cycling, indent, etc.) wins.
    onFocusNext: () => {
      if (focusedPane() !== "workspace") focus.cycle(1)
    },
    onFocusPrev: () => {
      if (focusedPane() !== "workspace") focus.cycle(-1)
    },
    focusCycleEnabled: () => focusedPane() !== "workspace",
    onQuit: quit,
  })

  // User-action handlers — every "verb that opens a dialog and calls
  // through to the orchestrator" lives in `./lib/use-task-actions.ts`.
  // See that hook for the new-task / rename-task / rename-chat-tab /
  // delete-task flows.
  const {
    openNewTaskFlow,
    quickForkActiveTask,
    confirmRenameTask,
    confirmRenameChatTab,
    confirmDeleteTask,
    confirmArchiveTask,
    confirmLocalMergeTask,
  } = useTaskActions({
    orchestrator: props.orchestrator,
    dialog,
    kv,
    selectedId,
    setSelectedId,
    setFocusedPane,
    savedRepos,
  })

  // Centralised keymap registration. All six top-level useBindings
  // call sites used to live inline here; they were consolidated into
  // app-keymap.tsx so the priority stack + scope rationale are
  // visible in one place. See that file for the registration order
  // and the rule about plain-letter vs modifier-prefixed chords.
  // Mirror of the sidebar's `/`-search active flag, lifted here so the
  // app keymap can gate the sidebar-scope plain-letter chords (n/s/q)
  // off while the user is typing in the search input. The Sidebar
  // component still owns the underlying signal; this is a one-way
  // observer wired via its `onSearchActiveChange` callback.
  const [sidebarSearchActive, setSidebarSearchActive] = createSignal(false)

  // Compute the (task, tab) currently visible to the user. "Visible"
  // means the workspace is on chat AND this is the active chat tab in
  // the active task. The focused-pane is irrelevant: even if the user
  // is currently typing in the sidebar, the chat tab they last looked
  // at is still on screen. Consumed by both the completion-notification
  // suppressor (don't toast a "done" the user can plainly see) and the
  // background-tasks surface (the visible tab is never "background").
  // We don't gate on the parent terminal having focus either — host
  // focus isn't reliably observable from a TUI.
  const visibleTabKey = createMemo<string | null>(() => {
    const taskId = selectedId()
    const tabId = activeChatTabIdAcc()
    if (!taskId || !tabId) return null
    if (!isChatTabActive()) return null
    return chatRunStateKey(taskId, tabId)
  })

  // Background-tasks manager opener. Wired to the global `ctrl+b`
  // chord and to the status-bar indicator's click target. Mirrors the
  // `openNewTaskFlow` pattern — a dialog-opening verb closing over the
  // reactive accessors it needs.
  const openBackgroundTasks = (): void => {
    BackgroundTasksDialog.show(dialog, {
      runState: chatRunStateAcc,
      tasks: tasksAcc,
      visibleTabKey,
      onJump: (taskId, tabId) => {
        // Persist the active tab before switching tasks so the chat
        // pane lands on the background tab, not the task's prior one.
        void props.orchestrator.setActiveTab(taskId, tabId)
        setSelectedId(taskId)
        setFocusedPane("workspace")
      },
      onInterrupt: (taskId, tabId) => {
        void props.orchestrator.interruptTask(taskId, tabId)
      },
    })
  }

  // Background sessions running out of view — projected once here and
  // shared by the status-bar indicator and the chat composer's
  // background-runs line. Excludes the currently-visible tab.
  const backgroundRows = createMemo(() => computeBackgroundRows(chatRunStateAcc(), tasksAcc(), visibleTabKey()))

  useAppKeymap({
    dialog,
    focusedPane,
    setFocusedPane,
    nudgeFocusedPane,
    resizeStep: RESIZE_STEP,
    focusHjklTargets: FOCUS_HJKL_TARGETS,
    openNewTaskFlow,
    openBackgroundTasks,
    kv,
    orchestrator: props.orchestrator,
    renderer,
    onQuit: quit,
    activeTask,
    openActiveTaskInEditor,
    sidebarSearchActive,
  })

  // Per-ChatTab completion notifications.
  useCompletionNotifications({
    chatRunState: chatRunStateAcc,
    tasks: tasksAcc,
    visibleTabKey,
    notifications,
  })
  // Clear the unread mark whenever the user is visibly looking at a
  // tab. Wraps the visible-tab-key computation rather than hooking
  // selectChatTabById so it also covers: switching back to chat from a
  // file tab, swapping tasks where the new active tab had a pending
  // unread, etc. — anywhere the chip becomes the in-view chip.
  createEffect(() => {
    const key = visibleTabKey()
    if (!key) return
    const idx = key.indexOf(":")
    if (idx < 0) return
    notifications.markRead(key.slice(0, idx), key.slice(idx + 1))
  })

  // Behavior-test side-channel — mounts globals on `globalThis` that
  // the fake-engine HTTP server reads at request time. See
  // `./lib/use-test-side-channel.ts` for the two globals
  // (__kobeTestRequestPR + __kobeTestRespondToInput) and why we route
  // PR/respondToInput through them instead of synthesizing keystrokes.
  // Production never sets KOBE_TEST_FAKE_PORT, so the globals are
  // harmless dead branches.
  useTestSideChannel({ orchestrator: props.orchestrator, activeTask })

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar
        orchestrator={props.orchestrator}
        activeTask={activeTask}
        activeChatTabId={activeChatTabIdAcc}
        updateInfo={updateInfo}
        worktreeOpener={worktreeOpener}
      />
      <box flexDirection="row" flexGrow={1}>
        {/* Left: task sidebar. Click anywhere on the sidebar pane to
            focus it. The right edge is a separate <ResizableEdge /> that
            owns the drag-to-resize affordance plus hover/focus colors.
            backgroundPanel paints a slightly-raised tone vs the chat
            (which keeps `theme.background`) — IDE convention is the
            auxiliary rails recede in saturation, the work area is the
            visual focus. */}
        <box
          flexShrink={0}
          flexDirection="column"
          backgroundColor={theme.backgroundPanel}
          onMouseUp={() => setFocusedPane("sidebar")}
        >
          <Sidebar
            width={sidebarWidth}
            tasks={tasksAcc}
            onSelect={(id: string) => {
              setSelectedId(id)
              // Selecting a task usually means "I want to look at it" —
              // pull focus to workspace so the user can immediately type
              // / scroll without another ctrl+2.
              setFocusedPane("workspace")
            }}
            onDeleteRequest={(id: string) => {
              void confirmDeleteTask(id)
            }}
            onArchiveRequest={(id: string) => {
              void confirmArchiveTask(id)
            }}
            onLocalMergeRequest={(id: string) => {
              void confirmLocalMergeTask(id)
            }}
            onRenameRequest={(id: string) => {
              void confirmRenameTask(id)
            }}
            onPinRequest={(id: string) => {
              void props.orchestrator.setPinned(id).catch((err) => {
                // eslint-disable-next-line no-console
                console.error("[kobe] setPinned failed:", err)
              })
            }}
            onAddTask={() => void openNewTaskFlow()}
            onSearchActiveChange={(active: boolean) => setSidebarSearchActive(active)}
            selectedId={selectedId}
            focused={isFocused("sidebar")}
          />
        </box>
        {/* Sidebar ↔ workspace splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={sidebarWidth}
          setSize={setSidebarWidth}
          clamp={clampSidebar}
          focused={isFocused("sidebar")}
        />
        {/* Center: tabbed (chat | <file>...) — primary interaction surface.
            Width controlled by workspaceWidth; the right edge is a
            <ResizableEdge /> sibling rather than a `border={["right"]}`
            on this box. No bg paint — the chat body inherits the
            renderer's `theme.background` (which the ThemeProvider
            forces to transparent under the transparent-bg toggle).
            Only the composer's `theme.backgroundElement` fill stays
            tinted in transparent mode, keeping the input area
            legible against any host wallpaper. */}
        <box
          flexDirection="column"
          flexShrink={0}
          width={workspaceWidth()}
          onMouseUp={() => setFocusedPane("workspace")}
        >
          <PaneHeader
            title="WORKSPACE"
            ordinal="j"
            subtitle={activeTask()?.title ?? "no task"}
            asideRight={workspaceAsideRight()}
            focused={focusedPane() === "workspace"}
          />
          <Show when={selectedId()}>
            <CenterTabStrip
              isChatActive={isChatTabActive}
              activeFile={activeFileTabPath}
              chatTabs={activeChatTabsAcc}
              activeChatTabId={activeChatTabIdAcc}
              activeTaskId={taskIdAcc}
              chatRunState={chatRunStateAcc}
              unread={notifications.unread}
              onSelectChat={selectChatTab}
              onSelectChatTab={selectChatTabById}
              onSelectFile={selectFileTab}
              onCloseFile={closeFileTab}
            />
          </Show>
          <box flexGrow={1}>
            <Show
              when={isChatTabActive()}
              fallback={
                <Preview
                  worktreePath={worktreePathAcc}
                  diffBase={diffBaseAcc}
                  onOpen={(api) => setPreviewApi(api)}
                  hideInternalTabs={() => true}
                  onExternalClose={closeFileTab}
                  focused={isFocused("workspace")}
                />
              }
            >
              <Chat
                orchestrator={props.orchestrator}
                taskId={taskIdAcc}
                title={activeTitleAcc}
                pendingPrompt={pendingPromptForActive}
                onPendingPromptConsumed={() => setPendingPrompt(null)}
                focused={isFocused("workspace")}
                onContextMeter={(label) => setWorkspaceContextAside(label)}
                onRenameTabRequest={(tabId: string) => {
                  void confirmRenameChatTab(tabId)
                }}
                onOpenFilePath={openFileInCenter}
                onQuickForkRequest={() => {
                  void quickForkActiveTask()
                }}
                backgroundRows={backgroundRows}
                onOpenBackgroundTasks={openBackgroundTasks}
              />
            </Show>
          </box>
        </box>
        {/* Workspace ↔ right column splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={workspaceWidth}
          setSize={setWorkspaceWidth}
          clamp={clampWorkspace}
          focused={isFocused("workspace")}
        />
        {/* Right column: FILES top + TERMINAL bottom. Width absorbs the
            remainder via flexGrow={1}; the FILES↔TERMINAL split is a
            <ResizableEdge orientation="horizontal" /> with a controlled
            filesHeight signal driving the upper pane. Same
            backgroundPanel tone as the sidebar so the two rails feel
            symmetric and the chat in the middle is visibly the focus. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} backgroundColor={theme.backgroundPanel}>
          <box flexShrink={0} height={filesHeight()} flexDirection="column" onMouseUp={() => setFocusedPane("files")}>
            <PaneHeader title="FILES" ordinal="k" focused={focusedPane() === "files"} />
            <box flexGrow={1}>
              <FileTree worktreePath={worktreePathAcc} onOpenFile={openFileInCenter} focused={isFocused("files")} />
            </box>
          </box>
          {/* Files ↔ terminal splitter. */}
          <ResizableEdge
            orientation="horizontal"
            size={filesHeight}
            setSize={setFilesHeight}
            clamp={clampFiles}
            focused={isFocused("files")}
          />
          <box
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            flexDirection="column"
            onMouseUp={() => setFocusedPane("terminal")}
          >
            <PaneHeader
              title="TERMINAL"
              ordinal="l"
              subtitle={worktreePathAcc() ? worktreePathAcc()?.split("/").slice(-1)[0] : undefined}
              focused={focusedPane() === "terminal"}
            />
            <box flexGrow={1}>
              <Terminal cwd={worktreePathAcc} taskId={taskIdNullAcc} focused={isFocused("terminal")} />
            </box>
          </box>
        </box>
      </box>
      <StatusBar
        indicator={
          <BackgroundTasksIndicator
            runState={chatRunStateAcc}
            tasks={tasksAcc}
            visibleTabKey={visibleTabKey}
            onActivate={openBackgroundTasks}
          />
        }
      />
      {/* Bottom-right transient toasts for background-tab completions
          and approval requests. Sits on its own position="absolute"
          layer above the panes but below the dialog backdrop. */}
      <ToastOverlay />
    </box>
  )
}

function App(props: AppDeps) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <NotificationsProvider>
          <SyncProvider>
            <DialogProvider>
              <CommandPaletteProvider>
                <FocusProvider>
                  <Shell {...props} />
                </FocusProvider>
              </CommandPaletteProvider>
            </DialogProvider>
          </SyncProvider>
        </NotificationsProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

/**
 * Mount the G2 app. Builds the orchestrator stack, then renders
 * `<App />`. Replaces `tui/index.tsx`'s previous banner mount.
 */
export async function startApp(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  // Register user-installed themes (`~/.kobe/themes/*.json`) BEFORE the
  // ThemeProvider mounts. ThemeProvider's `init` reads the active theme
  // out of the registry; if the user persisted a theme that lives in a
  // user file, it has to exist by registry time or the provider falls
  // back to the bundled default. Sync — see loader.ts header for why.
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
  if (process.env.KOBE_TEST_ENGINE || process.env.KOBE_NO_DAEMON === "1") {
    const engines = await buildEngines()
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const worktrees = new GitWorktreeManager()
    orchestrator = new Orchestrator({
      engines,
      store,
      worktrees,
      ...(process.env.KOBE_TEST_ENGINE ? { metadataSuggester: new NullMetadataSuggester() } : {}),
    })
    // Bridge: bind a Unix-socket RPC server + write an MCP config so
    // every claude subprocess kobe spawns gets the `kobe_*` tools.
    try {
      const { startBridge } = await import("../orchestrator/bridge/index.ts")
      await startBridge(orchestrator, { homeDir })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] bridge failed to start:", err)
    }
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
  // KOB-15: seed a pinned "main" task per saved repo. Idempotent:
  // ensureMainTask returns the existing main task on subsequent boots.
  // We read savedRepos from `state/repos.ts` (which honours
  // KOBE_HOME_DIR) rather than from the TUI's KV context — KV isn't
  // mounted yet, and we want behavior tests with a tmpdir HOME to see
  // the seeding too. Failures per repo are logged and swallowed so a
  // single bad path can't gate the whole UI from booting.
  //
  // Heal legacy saved-repos written before addSavedRepo normalized
  // paths to the git toplevel: a subdir (e.g. `packages/kobe`) seeded
  // a main task whose FileTree rendered the entire monorepo rooted at
  // `packages/...` because `git ls-files --full-name` is toplevel-
  // relative. Resolving once at boot folds the entry back to the repo
  // root and dedupes any pair that collapses to the same toplevel.
  normalizeSavedRepos()
  for (const repo of getSavedRepos()) {
    try {
      await orchestrator.ensureMainTask(repo)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[kobe] ensureMainTask failed for ${repo}:`, err)
    }
  }
  // Replay persisted prompt history into the in-memory STORE before
  // the first composer mounts (KOB-157). Sync read of a small JSONL
  // file under `<kobeStateDir()>/composer-history.jsonl`. The set of
  // live task ids lets bootstrapHistory replay entries under their
  // original task id when that task still exists (so the same task's
  // ↑ walks past sessions naturally) and fall back to a synthetic
  // `project-<root>` key when the task was deleted between sessions
  // (those entries surface only via Ctrl+R). Failures are swallowed
  // inside `bootstrapHistory` — a fresh install with no history file
  // is the most common case and shouldn't slow boot or warn.
  bootstrapHistory({ liveTaskIds: new Set(orchestrator.listTasks().map((t) => t.id)) })
  // Renderer-level background: transparent so the host terminal's
  // background (theme, image, transparency setting) shows through where
  // panes don't paint. opentui PR #824 / v0.1.89+ added this — earlier
  // versions composited transparent regions against opaque black.
  // exitOnCtrlC: false — opentui's default kills the process on a single
  // Ctrl+C. Jackson wants the standard "first press copies / arms,
  // second press quits" UX, owned by useKobeKeybindings.
  // useKittyKeyboard:{} — opt into the kitty / CSI-u keyboard
  // protocol. Most kobe shortcuts are deliberately legacy-safe
  // ctrl+letter chords, but CSI-u lets supporting terminals distinguish
  // richer shortcuts such as shift+enter, ctrl+enter, ctrl+pageup, and
  // modifier-prefixed punctuation/digits. Kitty/foot/iTerm2/recent
  // Terminal.app reply to the enable sequence and start sending events
  // with full modifier info. tmux users need `set -g extended-keys on`
  // (and recent enough tmux) plus an `*:extkeys` terminal feature for
  // those sequences to pass through. Non-supporting terminals fall back
  // to legacy mode silently — no regression, just fewer distinguishable
  // shortcuts.
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
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
