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
import { SIDEBAR_MODE_KEY, resolveSidebarMode } from "../../state/sidebar-tree"
import { buildPRPrompt, gatherPRPromptState } from "../../tui/ops/pr-prompt"
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
import { useAccessor } from "../lib/use-accessor"
import { useDaemonNotices } from "../lib/use-daemon-notices"
import { useLatest } from "../lib/use-latest"
import { FileTree } from "../panes/filetree/FileTree"
import type { SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarHoverTooltip } from "../panes/sidebar/hover-tooltip"
import { useSidebarHostState } from "../panes/sidebar/use-sidebar-host-state.tsx"
import { useDialog } from "../ui/dialog"
import { useWorkspaceKeybindings } from "./host-keybindings"
import { renderContentPage, renderFullWindowPage, useHostPagesState } from "./host-pages"
import { HostSidebar } from "./host-sidebar"
import { useWorkspaceTaskActions } from "./host-task-actions"
import { HostTerminalContent } from "./host-terminal-content"
import { requestTaskWorktreeOpen } from "./open-task-worktree"
import {
  clearOptimisticMark,
  mergeOptimisticActivity,
  optimisticActivityStore,
  supersededMarks,
} from "./optimistic-activity"
import { useQuickFork } from "./quick-fork"
import { activeTabIdFor, forgetTaskTabs, requestTabActivation, setUiEventReporter } from "./terminal-tabs-shared"
import { useAgentChannels } from "./use-agent-channels"
import { useAttention } from "./use-attention"
import { useFileOpenActions } from "./use-file-open-actions"
import { useInboxHost } from "./use-inbox-host"
import { useIssueChat } from "./use-issue-chat"
import { useWorkspaceSelection } from "./use-workspace-selection"
import { useZenMode } from "./use-zen-mode"

const WORKTREE_TOOLS_MIN_WIDTH = 22
const WORKTREE_TOOLS_MAX_WIDTH = 34

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

  const [sidebarHover, setSidebarHover] = useState<SidebarHover | null>(null)
  // Task-lifecycle UI state (issue #20): project filter + sidebar-search gate
  // muting host letter chords while typing. Move mode / sort pref / toasts
  // live in useSidebarHostState below. KNOWN GAP vs the Tasks pane: no live
  // `ui-prefs` follow for sortMode/projectFilter (deliberate for now).
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [searchActive, setSearchActive] = useState(false)

  const available = Math.max(WORKTREE_TOOLS_MIN_WIDTH, dims.width - SIDEBAR_WIDTH)
  const worktreeToolsWidth = Math.max(
    WORKTREE_TOOLS_MIN_WIDTH,
    Math.min(WORKTREE_TOOLS_MAX_WIDTH, Math.floor(available / 3)),
  )

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

  const openEditorTabFn = useRef<((command: readonly string[], label: string) => void) | null>(null)
  const sendToEngineFn = useRef<((text: string) => void) | null>(null)
  const openDiffTabFn = useRef<((relPath: string, label: string, base?: string) => void) | null>(null)

  // Identity guard for the async actions below: after an await, the selected
  // task (and therefore the TerminalTabs mount behind the imperative refs) may
  // have changed — a stale continuation must not deliver into the new task.
  const selectedWorktreeRef = useLatest(worktree)

  /** FileTree `pr` chip + prefix+p — PTY paste+submit of the PR prompt.
   *  On the target branch (a project main session) it toasts instead. */
  async function createPR(): Promise<void> {
    const wt = worktree
    const send = sendToEngineFn.current
    if (!wt || !send) return
    const state = await gatherPRPromptState(wt)
    if (state.branch === state.targetBranch)
      return notifyError(t("files.toast.prOnTargetBranch", { branch: state.branch }))
    const prompt = await buildPRPrompt(wt, state)
    if (selectedWorktreeRef.current !== wt || sendToEngineFn.current !== send) return
    send(prompt)
  }

  // Quick-fork (issue #17, ctrl+f): composer → create+enter → hand the
  // prompt to the new task's TerminalTabs mount (phase 2). Wiring lives in
  // `quick-fork.ts` — the create/enter/pending-prompt shape is identical
  // regardless of host, and this component is already near the file-size cap.
  const quickFork = useQuickFork(orch, { selectTask: setSelectedId, enterTask: activateTask, notifyError })

  /* --------- zen mode (issue #18, pure-tui shape) ----------------------- */
  const { zen, toggleZen } = useZenMode({ kv, focus })

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
  const agentChannels = useAgentChannels({
    tasks,
    selectedTask,
    kv,
    dialog,
    t,
    notifyError,
    onOpen: () => {
      pages.setNav("terminal")
      focus.setFocused("workspace")
    },
  })
  // Sidebar layout: the tree lists each worktree's tabs as rows (the strip is
  // off by default to match); `flat` restores the PROJECTS / TASKS list.
  const sidebarMode = resolveSidebarMode(kv.get(SIDEBAR_MODE_KEY, undefined))
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
    filesPaneVisible: !zen && pages.nav === "terminal" && !agentChannels.selectedChannel,
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
    createPR: () => {
      if (!agentChannels.selectedChannel) void createPR()
    },
    connectChannel: agentChannels.selectedChannel ? undefined : agentChannels.connectCurrent,
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

  const fullWindowPage = renderFullWindowPage(pageDeps)
  if (fullWindowPage) return fullWindowPage
  const openPage = renderContentPage(pageDeps)

  if (pages.settingsOpen) {
    return (
      <box flexGrow={1} backgroundColor={theme.background} paddingTop={1}>
        <SettingsDialog kv={kv} orchestrator={orch} standalone={true} onClose={pages.closeSettings} />
      </box>
    )
  }

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      <HostSidebar
        mode={sidebarMode}
        width={SIDEBAR_WIDTH}
        nav={pages.nav}
        onNavChange={pages.goToNav}
        tasks={tasks}
        selectedId={selectedId}
        selectedTabId={selectedTabId}
        channels={agentChannels.channels}
        selectedChannelId={agentChannels.selectedChannelId}
        onSelectChannel={agentChannels.openChannel}
        // Picking a task means "show me that task" — so it returns the
        // content pane to its terminal. Without this the rail page stayed
        // up and selecting a row did nothing visible.
        onSelect={(id) => {
          agentChannels.leaveChannel()
          selectTask(id)
          pages.setNav("terminal")
        }}
        onActivate={(id) => {
          agentChannels.leaveChannel()
          pages.setNav("terminal")
          void activateTask(id)
        }}
        // Picking a TAB is entering that session (owner 2026-08-01): focus
        // moves to the terminal, same as activate — a click that leaves the
        // sidebar's letter chords (d!) live under your typing is how issues
        // got mis-deleted.
        onSelectTab={(taskId, tabId) => {
          agentChannels.leaveChannel()
          pages.setNav("terminal")
          requestTabActivation(taskId, tabId)
          focus.setFocused("workspace")
        }}
        engineState={sidebarEngineState}
        engineLifecycle={engineLifecycle}
        taskJobs={taskJobs}
        worktreeChanges={worktreeChanges}
        transcriptActivity={transcriptActivity}
        focused={activePane === "sidebar"}
        onHoverChange={(hover) => setSidebarHover(hover)}
        hoverEnabled={kv.get("sidebar.hover.enabled", false) === true}
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
        sortMode={sortMode}
        onSortModeToggle={toggleSortMode}
        projectFilter={projectFilter}
        onProjectFilterChange={setProjectFilter}
        onSearchActiveChange={setSearchActive}
        headerStatus={{
          label: `${t("workspace.inbox.title")} ${inbox.counts.total}`,
          emphasize: inbox.counts.total > 0,
        }}
        onHeaderStatusClick={inbox.show}
        zenActive={zen}
        onZenClick={toggleZen}
        onFocusRequest={() => focus.setFocused("sidebar")}
      />

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
          <HostTerminalContent
            channel={agentChannels.selectedChannel}
            tasks={tasks}
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
          />
        )}
      </box>

      {!zen && !openPage && !agentChannels.selectedChannel ? (
        <box
          width={worktreeToolsWidth}
          flexShrink={0}
          borderColor={focus.focused === "files" ? theme.focusAccent : inactiveBorder}
          onMouseUp={() => focus.setFocused("files")}
        >
          <FileTree
            worktreePath={worktree}
            paneWidth={worktreeToolsWidth - 2 /* box border */}
            prBaseRef={selectedTask?.prStatus?.baseRef}
            focused={activePane === "files"}
            onOpenFile={(relPath) => void openFileInEditor(relPath)}
            onOpenDiff={openDiff}
            onZenToggle={toggleZen}
            onCreatePR={() => void createPR()}
          />
        </box>
      ) : null}

      <SidebarHoverTooltip hover={sidebarHover} dims={dims} />
      {/* Cross-task attention toasts (issue #15). `useAttention` above fires
          `notif.notify()` on unfocused-task state changes, but the main app
          never mounted the overlay that renders them (only the standalone
          `kobe tasks` pane did) — so the bottom-right toast silently never
          appeared. Absolute-positioned like SidebarHoverTooltip, under the
          host's NotificationsProvider. */}
      <ToastOverlay />
      {/* Prefix sequence HUD — bottom-left over the Tasks sidebar (the
          terminal column is off-limits: it collided with the engine's own
          status line). Width-capped to the rail so lines never spill into
          the terminal. */}
      <PrefixHud left={1} width={SIDEBAR_WIDTH - 2} />
    </box>
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
