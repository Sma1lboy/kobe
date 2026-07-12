/** @jsxImportSource @opentui/react */
/**
 * Default PureTUI workspace: Sidebar | engine Terminal |
 * Files. `useAccessor` subscribes React to framework-free daemon state; imperative
 * terminal handoffs use refs, and worktree-scoped TerminalTabs mount by key.
 * Settings, worktrees, and update surfaces swap in-process instead of exiting.
 */

import { join } from "node:path"
import { useTerminalDimensions } from "@opentui/react"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { useEffect, useRef, useState } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { resolveEditorLaunch } from "../../tui/lib/editor-launch.ts"
import { pathLeaf } from "../../tui/lib/path-helpers"
import { buildPRPrompt } from "../../tui/ops/pr-prompt"
import { openExternally } from "../../tui/panes/filetree/open-external"
import { SIDEBAR_WIDTH } from "../../tui/panes/sidebar/view-core"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { KanbanPage } from "../component/kanban-page"
import { PrefixHud } from "../component/prefix-hud"
import { SettingsDialog } from "../component/settings-dialog"
import { ToastOverlay } from "../component/toast-overlay"
import { UpdatePage } from "../component/update-page.tsx"
import { WorktreesPage } from "../component/worktrees-page"
import { useFocus } from "../context/focus"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useAccessor } from "../lib/use-accessor"
import { useDaemonNotices } from "../lib/use-daemon-notices"
import { FileTree } from "../panes/filetree/FileTree"
import { Sidebar, type SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarHoverTooltip } from "../panes/sidebar/hover-tooltip"
import { useSidebarHostState } from "../panes/sidebar/use-sidebar-host-state.tsx"
import { useDialog } from "../ui/dialog"
import { forgetTaskTabs } from "./TerminalTabs"
import { useWorkspaceKeybindings } from "./host-keybindings"
import { useWorkspaceTaskActions } from "./host-task-actions"
import { useQuickFork } from "./quick-fork"
import { ShowWorkspace } from "./show-workspace"
import { sweepOrphanTabsSnapshots } from "./terminal-tabs-persist"
import { useAttention } from "./use-attention"
import { useWorkspaceSelection } from "./use-workspace-selection"

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
  useDaemonNotices(orch, notif.notify)

  const tasks = useAccessor(orch.tasksSignal())
  const activeTaskId = useAccessor(orch.activeTaskSignal())
  const engineState = useAccessor(orch.engineStateSignal())
  const engineTabStates = useAccessor(orch.engineTabStatesSignal())
  const taskJobs = useAccessor(orch.taskJobsSignal())
  const worktreeChanges = useAccessor(orch.worktreeChangesSignal())

  const [sidebarHover, setSidebarHover] = useState<SidebarHover | null>(null)
  // Task-lifecycle UI state (issue #20 — parity with the tmux Tasks pane):
  // the project filter and the sidebar-search gate that mutes host letter
  // chords while the user types a query. Move mode, the global sort pref,
  // and the toast helpers live in the shared useSidebarHostState below.
  // KNOWN GAP vs the Tasks pane: this host does NOT follow live `ui-prefs`
  // pushes for sortMode/projectFilter (deliberate for now).
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
  })
  const worktree = selectedTask?.worktreePath || null

  // Toasts + global sort pref + move-mode — the wiring shared with the tmux
  // Tasks pane, extracted to the hook next to the Sidebar itself.
  const { sortMode, toggleSortMode, moveMode, setMoveMode, notifyError, notifyInfo, onLocalMergeRequest } =
    useSidebarHostState({ kv, notif, tasks, selectedId, setSelectedId })

  // Cross-task attention (P0): rising-edge notify for non-selected tasks +
  // the global chord's jump-to-next handler. State is engine-owned/neutral.
  const t = useT()
  const { jumpToNextAttention } = useAttention({
    tasks,
    engineState,
    engineTabStates,
    selectedId,
    kv,
    notif,
    selectTask,
    focusWorkspace: () => focus.setFocused("workspace"),
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

  // One-time orphan sweep (O19): clear historical `terminalTabs.*` snapshots
  // whose task no longer exists — the backlog that accumulated before
  // delete-time reclamation. Runs once, the first render the task list has
  // hydrated (the raw signal, so archived tasks are kept — their snapshots
  // are load-bearing for unarchive --resume). A ref, not a dep, so a later
  // task-list change never re-sweeps a live task's fresh snapshot.
  const sweptOrphansRef = useRef(false)
  useEffect(() => {
    if (sweptOrphansRef.current || tasks.length === 0) return
    sweptOrphansRef.current = true
    sweepOrphanTabsSnapshots(
      kv,
      tasks.map((task) => task.id),
    )
  }, [tasks, kv])

  // Imperative handle from the currently-mounted TerminalTabs (issue #16
  // editor-tab flow). A ref (not a plain `let` — this component re-renders
  // every state change, unlike Solid's once-per-setup body): FileTree's
  // "open" action only ever READS it at click time, and TerminalTabs
  // re-hands it on every mount (task/worktree switch).
  const openEditorTabFn = useRef<((command: readonly string[], label: string) => void) | null>(null)
  const sendToEngineFn = useRef<((text: string) => void) | null>(null)
  // Read-only diff tab opener (issue #21) — same ref pattern as the editor
  // tab: TerminalTabs re-hands it per mount, FileTree's `d` reads it at
  // keypress. Opening is a content swap; the host does NOT focus the
  // workspace here (KOB-25 — a read-only open must not pull focus).
  const openDiffTabFn = useRef<((relPath: string, label: string, base?: string) => void) | null>(null)

  /** FileTree corner `pr` action — the Ops pane's createPR verbatim, with
   *  the tmux send-keys half swapped for a PTY paste+submit. */
  async function createPR(): Promise<void> {
    const wt = worktree
    if (!wt || !sendToEngineFn.current) return
    const prompt = await buildPRPrompt(wt)
    sendToEngineFn.current(prompt)
  }

  // Quick-fork (issue #17, ctrl+f): composer → create+enter → hand the
  // prompt to the new task's TerminalTabs mount (phase 2). Wiring lives in
  // `quick-fork.ts` — the create/enter/pending-prompt shape is identical
  // regardless of host, and this component is already near the file-size cap.
  const quickFork = useQuickFork(orch, { selectTask: setSelectedId, enterTask: activateTask, notifyError })

  /* --------- zen mode (issue #18, pure-tui shape) ----------------------- */
  const [zen, setZen] = useState(false)
  function toggleZen(): void {
    const next = !zen
    setZen(next)
    if (next) focus.setFocused("workspace")
  }
  useEffect(() => {
    if (focus.focused === "files") setZen(false)
  }, [focus.focused])

  /**
   * FileTree's Enter action (issue #16 editor-tab flow): resolve the user's
   * real editor via the tmux-agnostic `resolveEditorLaunch`, then run it in
   * the reusable File tab. Falls back to the host-OS opener when no
   * editor is configured/installed.
   */
  async function openFileInEditor(relPath: string): Promise<void> {
    const wt = worktree
    if (!wt) return
    const abs = join(wt, relPath)
    const launch = openEditorTabFn.current ? await resolveEditorLaunch(wt, abs) : null
    if (!launch) {
      openExternally(abs)
      return
    }
    openEditorTabFn.current?.(["sh", "-c", launch.command], launch.label)
    focus.setFocused("workspace")
  }

  /**
   * FileTree's `d` action (issue #21): open a file's read-only diff in the
   * workspace content tab. The file's basename labels the tab; `base` (when
   * the Changes tab is in Branch scope) makes it a vs-base diff. Deliberately
   * NO `focus.setFocused` — a read-only open is a content swap, not a
   * navigation (KOB-25), so the FileTree keeps keyboard focus.
   */
  function openDiff(relPath: string, base?: string): void {
    const label = pathLeaf(relPath)
    openDiffTabFn.current?.(relPath, label, base)
  }

  // Full-page swap — like the tmux `chattab` surface opening a dedicated
  // `kobe settings` window. Theme/transparent/focus accent changes apply
  // centrally via host-boot's UiPrefsSync, so there's no workspace-pane
  // refresh to trigger on close.
  const [settingsOpen, setSettingsOpen] = useState(false)
  function openSettings(): void {
    setSettingsOpen(true)
  }
  function closeSettings(): void {
    setSettingsOpen(false)
  }
  // Worktrees page (issue #23) — placeholder swap, see file header GAP note.
  const [worktreesOpen, setWorktreesOpen] = useState(false)
  // Kanban page — the daemon issue store as a board, same swap shape.
  const [kanbanOpen, setKanbanOpen] = useState(false)
  // Update page (issue #23 remainder) — same in-place swap shape as
  // WorktreesPage; UpdatePage's onClose seam makes this safe (it no longer
  // process.exit(0)s on close — only the post-update self-replace does).
  const [updateOpen, setUpdateOpen] = useState(false)

  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen,
    worktreesOpen,
    openWorktrees: () => setWorktreesOpen(true),
    updateOpen,
    openUpdate: () => setUpdateOpen(true),
    kanbanOpen,
    openKanban: () => setKanbanOpen(true),
    searchActive,
    selectedId,
    openSettings,
    closeSettings,
    createTask: () => void createTask(),
    renameBranch: (id) => void renameBranch(id),
    cycleVendor: (id) => void cycleVendor(id),
    toggleZen,
    jumpToNextAttention,
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

  if (worktreesOpen) {
    return <WorktreesPage orchestrator={orch} onClose={() => setWorktreesOpen(false)} />
  }

  if (kanbanOpen) {
    return <KanbanPage orchestrator={orch} onClose={() => setKanbanOpen(false)} />
  }

  if (updateOpen) {
    return <UpdatePage onClose={() => setUpdateOpen(false)} />
  }

  if (settingsOpen) {
    return (
      <scrollbox
        flexGrow={1}
        backgroundColor={theme.background}
        paddingTop={1}
        verticalScrollbarOptions={{ trackOptions: { foregroundColor: "transparent" } }}
      >
        <SettingsDialog kv={kv} orchestrator={orch} standalone={true} onClose={closeSettings} />
      </scrollbox>
    )
  }

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={theme.background}>
      {/* Tasks sidebar stays visible in zen (tmux parity) — its
          ☯ ZEN chip is also the exit affordance. */}
      <box
        width={SIDEBAR_WIDTH}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
        borderColor={focus.focused === "sidebar" ? theme.focusAccent : inactiveBorder}
        onMouseUp={() => focus.setFocused("sidebar")}
      >
        <Sidebar
          // The host box is SIDEBAR_WIDTH *including* its 2 border cells;
          // without this, Sidebar's imperative self-width (32) overflows the
          // inner 30 and the cursor row's background paints over the border.
          width={SIDEBAR_WIDTH - 2}
          tasks={tasks}
          selectedId={selectedId}
          onSelect={selectTask}
          onActivate={(id) => void activateTask(id)}
          engineState={engineState}
          taskJobs={taskJobs}
          worktreeChanges={worktreeChanges}
          focused={activePane === "sidebar"}
          onHoverChange={(hover) => setSidebarHover(hover)}
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
          zenActive={zen}
          onZenClick={toggleZen}
        />
      </box>

      <box
        flexGrow={1}
        flexShrink={1}
        borderColor={focus.focused === "workspace" ? theme.focusAccent : inactiveBorder}
        onMouseUp={() => focus.setFocused("workspace")}
      >
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
        />
      </box>

      {!zen ? (
        <box
          width={worktreeToolsWidth}
          flexShrink={0}
          borderColor={focus.focused === "files" ? theme.focusAccent : inactiveBorder}
          onMouseUp={() => focus.setFocused("files")}
        >
          <FileTree
            worktreePath={worktree}
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
