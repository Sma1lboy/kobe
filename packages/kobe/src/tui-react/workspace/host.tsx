/** @jsxImportSource @opentui/react */
/**
 * Default PureTUI workspace: Sidebar | engine Terminal |
 * Files. `useAccessor` subscribes React to framework-free daemon state; imperative
 * terminal handoffs use refs, and worktree-scoped TerminalTabs mount by key.
 * Settings, worktrees, and update surfaces swap in-process instead of exiting.
 */

import { useTerminalDimensions } from "@opentui/react"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { useEffect, useMemo, useRef, useState } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { SIDEBAR_WIDTH } from "../../tui/panes/sidebar/view-core"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { PrefixHud } from "../component/prefix-hud"
import { SettingsDialog } from "../component/settings-dialog"
import { ToastOverlay } from "../component/toast-overlay"
import { UpdatePage } from "../component/update-page.tsx"
import { useFocus } from "../context/focus"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { isNarrowWidth, narrowSurface } from "../lib/narrow-mode"
import { useAccessor } from "../lib/use-accessor"
import { useDaemonNotices } from "../lib/use-daemon-notices"
import { useLatest } from "../lib/use-latest"
import { useSidebarHostState } from "../panes/sidebar/use-sidebar-host-state.tsx"
import { useDialog } from "../ui/dialog"
import { HostFilesPane } from "./host-files-pane"
import { WorkspaceFrame } from "./host-footer"
import { useWorkspaceKeybindings } from "./host-keybindings"
import { renderContentPage, renderFullWindowPage, useHostPagesState } from "./host-pages"
import { HostSidebar } from "./host-sidebar"
import { useWorkspaceTaskActions } from "./host-task-actions"
import { requestTaskWorktreeOpen } from "./open-task-worktree"
import {
  clearOptimisticMark,
  mergeOptimisticActivity,
  optimisticActivityStore,
  supersededMarks,
} from "./optimistic-activity"
import { useQuickFork } from "./quick-fork"
import { ShowWorkspace } from "./show-workspace"
import { activeTabIdFor, forgetTaskTabs, requestTabActivation, setUiEventReporter } from "./terminal-tabs-shared"
import { useAttention } from "./use-attention"
import { useCreatePR } from "./use-create-pr"
import { useFileOpenActions } from "./use-file-open-actions"
import { useInboxHost } from "./use-inbox-host"
import { useIssueChat } from "./use-issue-chat"
import { useScratchAdopt } from "./use-scratch-adopt"
import { useScratchShell } from "./use-scratch-shell"
import { useWorkspaceSelection } from "./use-workspace-selection"
import { useZenMode } from "./use-zen-mode"

function WorkspaceRoot(props: { orchestrator: RemoteOrchestrator }) {
  const { theme, transparentBackground } = useTheme()
  const inactiveBorder = transparentBackground ? theme.border : theme.borderSubtle
  const dialog = useDialog()
  const kv = useKV()
  const focus = useFocus()
  const dims = useTerminalDimensions()
  const notif = useNotifications()
  const orch = props.orchestrator
  // Daemon-broadcast toasts (`kobe api notify` → notice.event).
  useDaemonNotices(orch, notif.notify, dialog)

  const tasks = useAccessor(orch.tasksSignal())
  const activeTaskId = useAccessor(orch.activeTaskSignal())
  const engineState = useAccessor(orch.engineStateSignal())
  const engineLifecycle = useAccessor(orch.engineLifecycleSignal())
  // Per-TAB activity. The daemon reports both levels; the task entry is a
  // last-event-wins rollup, so a task whose live tab is not the one the
  // rollup last described reads as idle. The sidebar tree needs the tab
  // level to light the right row.
  const engineTabState = useAccessor(orch.engineTabStatesSignal())
  // Sidebar-only optimistic overlay: local enter/esc keypresses flip the
  // icon immediately; authoritative events always win, and a superseded
  // mark is dropped so the overlay never becomes a second source of truth.
  const optimisticMarks = useAccessor(optimisticActivityStore)
  const sidebarEngineState = useMemo(
    () => mergeOptimisticActivity(engineState, optimisticMarks),
    [engineState, optimisticMarks],
  )
  useEffect(() => {
    for (const taskId of supersededMarks(engineState, optimisticMarks)) clearOptimisticMark(taskId)
  }, [engineState, optimisticMarks])
  const inboxItems = useAccessor(orch.attentionInboxSignal())
  const taskJobs = useAccessor(orch.taskJobsSignal())
  const worktreeChanges = useAccessor(orch.worktreeChangesSignal())
  // Proves a "complete" turn whose engine is still writing — the hook-silent
  // long-tool / background-subagent phase (see row-view's completion rule).
  const transcriptActivity = useAccessor(orch.transcriptActivitySignal())

  // Sidebar-search gate: mutes the host's letter chords while typing. Move
  // mode / toasts live in useSidebarHostState below.
  const [searchActive, setSearchActive] = useState(false)

  // Narrow mode (issue #14, phone SSH): sidebar/workspace go mutually
  // exclusive, files pane hides — all gated here so ≥70 cols is unchanged.
  const narrow = isNarrowWidth(dims.width)

  // Selection + adopt-first-focus + the archived-task PTY sweep — extracted
  // verbatim to use-workspace-selection.ts (file-size cap split).
  const { selectedId, setSelectedId, selectedTask, selectTask, activateTask } = useWorkspaceSelection({
    orch,
    tasks,
    activeTaskId,
    focusWorkspace: () => focus.setFocused("workspace"),
    kv,
  })
  const worktree = selectedTask?.worktreePath || null

  // Toasts + global sort pref + move-mode — the wiring shared with the tmux
  // Tasks pane, extracted to the hook next to the Sidebar itself.
  const { sortMode, toggleSortMode, moveMode, setMoveMode, notifyError, notifyInfo, onLocalMergeRequest } =
    useSidebarHostState({ kv, notif, tasks, selectedId, setSelectedId })

  const inbox = useInboxHost({
    orchestrator: orch,
    items: inboxItems,
    tasks,
    kv,
    dialog,
    selectedId,
    selectTask,
    focusWorkspace: () => focus.setFocused("workspace"),
    notifyError,
  })

  // Cross-task attention (P0): rising-edge notify for non-selected tasks +
  // the global chord's jump-to-next handler. State is engine-owned/neutral.
  const t = useT()
  const { jumpToNextAttention } = useAttention({
    tasks,
    engineState,
    engineTabState,
    inboxItems: inbox.availableItems,
    selectedId,
    kv,
    notif,
    openAttention: inbox.openItem,
    noTasksMessage: t("workspace.attention.none"),
  })

  // Task-action callbacks (new/archive/delete/rename/branch/engine/pin/move)
  // — the shared lib/task-actions flows live in host-task-actions.ts.
  const { createTask, archiveTask, deleteTask, renameTask, renameBranch, cycleVendor, togglePin, moveTask } =
    useWorkspaceTaskActions({
      orchestrator: orch,
      tasks: () => tasks,
      dialog,
      notifyError,
      notifyInfo,
      selectedId: () => selectedId,
      setSelectedId,
      selectedTask: () => selectedTask,
      activateTask,
      forgetTaskTabs: (id) => forgetTaskTabs(kv, id),
    })

  // Imperative handle from the currently-mounted TerminalTabs (issue #16):
  // a ref, since FileTree's "open" only READS it at click time and
  // TerminalTabs re-hands it on every mount (task/worktree switch).
  const openEditorTabFn = useRef<((command: readonly string[], label: string) => void) | null>(null)
  const sendToEngineFn = useRef<((text: string) => void) | null>(null)
  // Read-only diff tab opener (issue #21) — same ref pattern as the editor
  // tab: TerminalTabs re-hands it per mount, FileTree's `d` reads it at
  // keypress. Opening is a content swap; the host does NOT focus the
  // workspace here (KOB-25 — a read-only open must not pull focus).
  const openDiffTabFn = useRef<((relPath: string, label: string, base?: string) => void) | null>(null)

  // Identity guard for the async actions below: after an await, the selected
  // task (and therefore the TerminalTabs mount behind the imperative refs) may
  // have changed — a stale continuation must not deliver into the new task.
  const selectedWorktreeRef = useLatest(worktree)

  // FileTree `pr` chip + prefix+p — split out for the file-size cap.
  const createPR = useCreatePR({ worktree, sendToEngineFn, selectedWorktreeRef, notifyError })

  // Quick-fork (issue #17, ctrl+f): composer → create+enter → hand the
  // prompt to the new task's TerminalTabs mount (phase 2). Wiring lives in
  // `quick-fork.ts` — the create/enter/pending-prompt shape is identical
  // regardless of host, and this component is already near the file-size cap.
  const quickFork = useQuickFork(orch, { selectTask: setSelectedId, enterTask: activateTask, notifyError })

  // Scratch temp shell tasks (issue #33): open gesture + last-shell-exit
  // deletion, plus the quiet cwd+harness → project adoption loop.
  const scratch = useScratchShell({
    orchestrator: orch,
    tasks,
    enterTask: (id) => void activateTask(id),
    forgetTaskTabs: (id) => forgetTaskTabs(kv, id),
    notifyError,
  })
  useScratchAdopt({ tasks, orchestrator: orch, notifyInfo })

  /* --------- zen mode (issue #18, pure-tui shape) ----------------------- */
  const { zen, toggleZen } = useZenMode({ kv, focus })

  // Narrow hides the files pane entirely, so a focus stranded there (a
  // resize below the breakpoint mid-session) falls back to the workspace —
  // otherwise plain keys would land in an unmounted pane.
  useEffect(() => {
    if (narrow && focus.focused === "files") focus.setFocused("workspace")
  }, [narrow, focus])

  // Tab open/close (and editor-file close) edges report as plugin events
  // through this seam — wired once per host, torn down on unmount.
  useEffect(() => {
    setUiEventReporter((kind, taskId, detail) => orch.reportUiEvent(kind, taskId, detail))
    return () => setUiEventReporter(null)
  }, [orch])

  // FileTree's Enter (editor/plugin/OS) and `d` (read-only diff tab).
  const { openFileInEditor, openDiff } = useFileOpenActions({
    orch,
    worktree,
    selectedId,
    focus,
    openEditorTabFn,
    openDiffTabFn,
    selectedWorktreeRef,
  })

  // Which surface the workspace shows — settings/worktrees/update full swaps
  // plus the rail's one-at-a-time nav. State + rationale in host-pages.tsx.
  const pages = useHostPagesState(focus)
  // Sidebar layout: the tree lists each worktree's tabs as rows (the strip is
  // off by default to match); `flat` restores the PROJECTS / TASKS list.
  // The selected task's active tab — the tree marks that exact row as live.
  // Read from the module map rather than threaded through TerminalTabs: the
  // sidebar renders tabs for tasks whose TerminalTabs is not mounted, so the
  // module map is the only source that answers for all of them.
  const selectedTabId = selectedId === null ? null : activeTabIdFor(selectedId)
  // Kanban detail drawer → engine session (create/link/prompt handoff) —
  // quick-fork's pending-prompt pattern, per-placement (use-issue-chat.ts).
  const issueChat = useIssueChat(orch, {
    selectTask: setSelectedId,
    enterTask: activateTask,
    closeKanban: pages.closeKanban,
    notifyError,
    notifyInfo,
  })

  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen: pages.settingsOpen,
    worktreesOpen: pages.worktreesOpen,
    openWorktrees: pages.openWorktrees,
    updateOpen: pages.updateOpen,
    openUpdate: pages.openUpdate,
    kanbanOpen: pages.kanbanOpen,
    openKanban: pages.openKanban,
    filesPaneVisible: !zen && pages.nav === "terminal" && !narrow,
    automationsOpen: pages.automationsOpen,
    openAutomations: pages.openAutomations,
    workItemsOpen: pages.workItemsOpen,
    openWorkItems: pages.openWorkItems,
    searchActive,
    selectedId,
    openTaskWorktree: (id) =>
      void requestTaskWorktreeOpen(id, {
        taskPath: tasks.find((task) => task.id === id)?.worktreePath,
        ensureWorktree: orch.ensureWorktree.bind(orch),
        notifyError,
        noEditorMessage: t("tasks.toast.noEditor"),
        openFailedMessage: (label) => t("tasks.toast.openWorktreeFailed", { label }),
      }),
    openSettings: pages.openSettings,
    closeSettings: pages.closeSettings,
    createTask: () => void createTask(),
    renameBranch: (id) => void renameBranch(id),
    cycleVendor: (id) => void cycleVendor(id),
    toggleZen,
    jumpToNextAttention,
    openInbox: inbox.show,
    createPR: () => void createPR(),
    // prefix+m — global entry into the sidebar's move mode: focus the
    // sidebar, highlight the current selection, j/k reorders, enter/esc
    // exits. Falls back to the first task when nothing is selected.
    enterMoveMode: () => {
      const target = selectedId ?? tasks[0]?.id
      if (!target) return
      focus.setFocused("sidebar")
      setSelectedId(String(target))
      setMoveMode(true)
    },
    openScratchShell: scratch.openScratchShell,
  })

  // Keybinding focus is suppressed while a dialog overlay is up: pane focus
  // state (sidebar/workspace/files) does NOT change when a dialog opens, so
  // without this the pane's plain-letter bindings keep firing and — because
  // a matched binding calls preventDefault — swallow the keystroke before the
  // dialog's focused <input> can read it (opentui only routes a key to a
  // focused renderable when !defaultPrevented). Border colors keep using the
  // live `focus.focused` so the pane frame stays lit under the dim backdrop.
  const dialogOpen = dialog.stack.length > 0
  const activePane = dialogOpen ? null : focus.focused

  const pageDeps = {
    orchestrator: orch,
    selectedTask,
    worktreesOpen: pages.worktreesOpen,
    automationsOpen: pages.automationsOpen,
    workItemsOpen: pages.workItemsOpen,
    kanbanOpen: pages.kanbanOpen,
    updateOpen: pages.updateOpen,
    closeWorktrees: pages.closeWorktrees,
    closeAutomations: pages.closeAutomations,
    closeWorkItems: pages.closeWorkItems,
    closeKanban: pages.closeKanban,
    closeUpdate: pages.closeUpdate,
    activateTask: (taskId: string) => void activateTask(taskId),
    startIssueChat: issueChat.start,
    engineStates: engineState,
    contentFocused: activePane === "workspace",
  }

  // Worktrees / Update replace the whole window; the rail's pages replace only
  // the content pane, so the sidebar stays live beside them.
  const fullWindowPage = renderFullWindowPage(pageDeps)
  if (fullWindowPage) return fullWindowPage
  const openPage = renderContentPage(pageDeps)

  // Narrow: exactly one of sidebar/content renders; desktop renders both.
  const surface = narrow
    ? narrowSurface({ focusedPane: focus.focused, hasSelection: selectedTask != null, hasOpenPage: openPage != null })
    : null
  const showSidebar = surface !== "content"
  const showContent = surface !== "sidebar"
  // "↩ recent" jump target (issue #14, 2A): the daemon's active task — already
  // persisted as `lastActive.taskId`, so a cold reconnect still knows it.
  const recentTask = (narrow ? tasks.find((task) => task.id === activeTaskId && !task.archived) : null) ?? null

  if (pages.settingsOpen) {
    // The scrollbox lives inside SettingsDialog (standalone mode) so its
    // keyboard cursor can scrollChildIntoView on short terminals.
    return (
      <box flexGrow={1} backgroundColor={theme.background} paddingTop={1}>
        <SettingsDialog kv={kv} orchestrator={orch} standalone={true} onClose={pages.closeSettings} />
      </box>
    )
  }

  return (
    <WorkspaceFrame orchestrator={orch} onOpenSettings={pages.openSettings}>
      {/* Tasks sidebar stays visible in zen (tmux parity) — its
          ☯ ZEN chip is also the exit affordance. */}
      {/* Borderless rail (owner call 2026-07-27): no frame, no divider —
          opentui coerces a full frame if borderColor is ever set, so the box
          carries no border prop at all. The workspace frame's left edge is
          the only boundary; sidebar focus shows on the KOBE brand text. */}
      {showSidebar ? (
        <HostSidebar
          width={narrow ? dims.width : SIDEBAR_WIDTH}
          nav={pages.nav}
          onNavChange={pages.goToNav}
          tasks={tasks}
          selectedId={selectedId}
          selectedTabId={selectedTabId}
          // Picking a task means "show me that task" — so it returns the
          // content pane to its terminal. Without this the rail page stayed
          // up and selecting a row did nothing visible.
          onSelect={(id) => {
            selectTask(id)
            pages.setNav("terminal")
          }}
          onActivate={(id) => {
            pages.setNav("terminal")
            void activateTask(id)
          }}
          // Picking a TAB is entering that session (owner 2026-08-01): focus
          // moves to the terminal, same as activate — a click that leaves the
          // sidebar's letter chords (d!) live under your typing is how issues
          // got mis-deleted. Re-clicking the tab you are ALREADY in flips focus
          // back to the sidebar (owner 2026-08-09): the first click entered the
          // session, so a second click on the same row means "give me the
          // sidebar". Keyboard enter is exempt (sidebar already focused —
          // enter always means enter the session), as is a click that brings
          // the terminal back from a rail page.
          onSelectTab={(taskId, tabId) => {
            const reClick =
              pages.nav === "terminal" &&
              focus.focused !== "sidebar" &&
              taskId === selectedId &&
              tabId === selectedTabId
            pages.setNav("terminal")
            requestTabActivation(taskId, tabId)
            focus.setFocused(reClick ? "sidebar" : "workspace")
          }}
          engineState={sidebarEngineState}
          engineTabState={engineTabState}
          engineLifecycle={engineLifecycle}
          taskJobs={taskJobs}
          worktreeChanges={worktreeChanges}
          transcriptActivity={transcriptActivity}
          focused={activePane === "sidebar"}
          // Task lifecycle (issue #20): the Sidebar's own d/a/r/p/m keys
          // fire these; the flows are the shared lib/task-actions bodies.
          onAddTask={() => void createTask()}
          onDeleteRequest={(id) => void deleteTask(id)}
          onArchiveRequest={(id) => void archiveTask(id)}
          onRenameRequest={(id) => void renameTask(id)}
          onPinRequest={(id) => void togglePin(id)}
          moveMode={moveMode}
          onMoveRequest={(id, delta) => void moveTask(id, delta)}
          onMoveModeExit={() => setMoveMode(false)}
          onLocalMergeRequest={onLocalMergeRequest}
          onSearchActiveChange={setSearchActive}
          headerStatus={{
            label: `${t("workspace.inbox.title")} ${inbox.counts.total}`,
            emphasize: inbox.counts.total > 0,
          }}
          onHeaderStatusClick={inbox.show}
          zenActive={zen}
          onZenClick={toggleZen}
          onFocusRequest={() => focus.setFocused("sidebar")}
          recentTask={recentTask}
        />
      ) : null}

      {showContent ? (
        <box
          flexGrow={1}
          flexShrink={1}
          borderColor={focus.focused === "workspace" ? theme.focusAccent : inactiveBorder}
          onMouseUp={() => focus.setFocused("workspace")}
        >
          {/* The rail swaps THIS pane, not the whole window — the task list on
            the left stays live, so selecting a task is how you get back to
            its terminal. */}
          {openPage ?? (
            <ShowWorkspace
              task={selectedTask}
              worktree={worktree}
              orchestrator={orch}
              focused={activePane === "workspace"}
              onRequestFocus={() => focus.setFocused("workspace")}
              onEditorTabReady={(open) => {
                openEditorTabFn.current = open
              }}
              onEngineSendReady={(send) => {
                sendToEngineFn.current = send
              }}
              onDiffTabReady={(open) => {
                openDiffTabFn.current = open
              }}
              onQuickFork={quickFork.onQuickFork}
              initialPrompt={quickFork.initialPromptFor(selectedTask?.id)}
              onTabVisited={inbox.resolveVisited}
              onScratchExit={scratch.onScratchExit}
            />
          )}
        </box>
      ) : null}

      {/* The FileTree lists a WORKTREE's files. A rail page is not about a
          worktree — it reads daemon state that spans projects — so the pane
          would be showing an unrelated tree beside it. Hidden, same as zen
          (and always in narrow — three panes don't fit 46 cols). */}
      {!zen && !openPage && !narrow ? (
        <HostFilesPane
          worktree={worktree}
          prBaseRef={selectedTask?.prStatus?.baseRef}
          focused={activePane === "files"}
          onOpenFile={(relPath) => void openFileInEditor(relPath)}
          onOpenDiff={openDiff}
          onZenToggle={toggleZen}
          onCreatePR={() => void createPR()}
        />
      ) : null}

      {/* Cross-task attention toasts (issue #15). `useAttention` above fires
          `notif.notify()` on unfocused-task state changes, but the main app
          never mounted the overlay that renders them (only the standalone
          `kobe tasks` pane did) — so the bottom-right toast silently never
          appeared. Absolute-positioned overlay, under the
          host's NotificationsProvider. */}
      <ToastOverlay />
      {/* Prefix sequence HUD — bottom-left over the Tasks sidebar (the
          terminal column is off-limits: it collided with the engine's own
          status line). Width-capped to the rail so lines never spill into
          the terminal. */}
      <PrefixHud left={1} width={SIDEBAR_WIDTH - 2} />
    </WorkspaceFrame>
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
          // Detach, don't kill: hosted PTYs (the `kobe pty-host` process)
          // keep their engine sessions RUNNING in the background and
          // reattach on next boot. Local-backend PTYs (no detach()) are
          // still killed — a child of this process can't outlive it usefully.
          getDefaultPtyRegistry().detachAll()
        },
      }
    },
  })
}
