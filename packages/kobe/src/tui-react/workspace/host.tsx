/** @jsxImportSource @opentui/react */
/**
 * Experimental native opentui workspace (`KOBE_TUI=1`) — React port of
 * `tui/workspace/host.tsx` (issue #16 React migration). Single-process app:
 * Sidebar | engine Terminal | Files. The center column is the
 * terminal-in-the-middle seam (issue #16) — an in-process PTY running the
 * task's real interactive engine CLI (claude/codex), so kobe wraps the
 * engine's own TUI instead of re-rendering its stream.
 *
 * Solid→React deltas (the load-bearing ones):
 *   - `RemoteOrchestrator`'s live task/engine-state signals are Solid
 *     signals with no framework-free twin for most fields — `useAccessor`
 *     bridges `tasksSignal`/`activeTaskSignal`/`engineStateSignal`/
 *     `taskJobsSignal`/`worktreeChangesSignal` (see its header for why
 *     this reaches for a Solid `createRoot` bridge instead of growing
 *     `RemoteOrchestrator`, already over the file-size cap). `
 *     transcriptActivitySignal` already has an `ExternalStore` twin
 *     (`transcriptActivityStore`), consumed via `useSyncExternalStore`
 *     (same pattern as `tui-react/ops/host.tsx`).
 *   - `openEditorTabFn`/`sendToEngineFn` were plain `let`s in the Solid
 *     component body (which runs once, at setup) — React re-executes the
 *     component every render, so they're `useRef`s here instead; either
 *     side writing/reading through the ref keeps the imperative handoff
 *     correct regardless of which render's closure fired.
 *   - The `keyed Show` that gave each worktree its own `TerminalTabs`
 *     instance becomes a React `key={path}` on `<TerminalTabs>`.
 *
 *   - The in-process worktree-management page swap
 *     (`tui/component/worktrees-page.tsx`) is `component/worktrees-page.tsx`
 *     here — same `WorktreesPage` contract, wired below behind the
 *     `worktrees.open.sidebar` chord exactly like the Solid host's `Show`.
 */

import { join } from "node:path"
import { useTerminalDimensions } from "@opentui/react"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { resolveEditorLaunch } from "../../tmux/editor-launch.ts"
import { buildPRPrompt } from "../../tui/ops/pr-prompt"
import { openExternally } from "../../tui/panes/filetree/open-external"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import { SettingsDialog } from "../component/settings-dialog"
import { WorktreesPage } from "../component/worktrees-page"
import { useFocus } from "../context/focus"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { FileTree } from "../panes/filetree/FileTree"
import { Sidebar, type SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarHoverTooltip } from "../panes/sidebar/hover-tooltip"
import { useDialog } from "../ui/dialog"
import { TerminalTabs } from "./TerminalTabs"
import { useWorkspaceKeybindings } from "./host-keybindings"
import { useWorkspaceTaskActions } from "./host-task-actions"
import { useAccessor } from "./use-accessor"
import { useFilesBadge } from "./use-files-badge"

const SIDEBAR_WIDTH = 32
const WORKTREE_TOOLS_MIN_WIDTH = 22
const WORKTREE_TOOLS_MAX_WIDTH = 34

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
  const dims = useTerminalDimensions()
  const notif = useNotifications()
  const orch = props.orchestrator

  const tasks = useAccessor(orch.tasksSignal())
  const activeTaskId = useAccessor(orch.activeTaskSignal())
  const engineState = useAccessor(orch.engineStateSignal())
  const taskJobs = useAccessor(orch.taskJobsSignal())
  const worktreeChanges = useAccessor(orch.worktreeChangesSignal())
  const transcriptActivityStore = orch.transcriptActivityStore()
  const transcriptActivity = useSyncExternalStore(
    transcriptActivityStore.subscribe,
    transcriptActivityStore.get,
    transcriptActivityStore.get,
  )

  const [selectedId, setSelectedId] = useState<string | null>(() => orch.activeTaskSignal()())
  const [sidebarHover, setSidebarHover] = useState<SidebarHover | null>(null)
  // Task-lifecycle UI state (issue #20 — parity with the tmux Tasks pane):
  // move mode (m + arrows reorder), the global sort preference (kv-fanned
  // like theme), the project filter, and the sidebar-search gate that mutes
  // host letter chords while the user types a query.
  const [moveMode, setMoveMode] = useState(false)
  const [sortMode, setSortModeSig] = useState<"default" | "recent">(() =>
    kv.get("activeSortMode", "default") === "recent" ? "recent" : "default",
  )
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [searchActive, setSearchActive] = useState(false)

  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId ?? "", tabId: "", title: message })
  }
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: message })
  }

  const available = Math.max(WORKTREE_TOOLS_MIN_WIDTH, dims.width - SIDEBAR_WIDTH)
  const worktreeToolsWidth = Math.max(
    WORKTREE_TOOLS_MIN_WIDTH,
    Math.min(WORKTREE_TOOLS_MAX_WIDTH, Math.floor(available / 3)),
  )
  const selectedTask: Task | undefined = selectedId ? tasks.find((task) => task.id === selectedId) : undefined
  const worktree = taskWorktree(selectedTask)

  // Files-column activity badge (issue #21) — the `● new` transcript badge
  // + its refresh-as-ack, extracted to `use-files-badge.ts` (file-size cap).
  const { cornerBadge: filesCornerBadge, ackRefresh: ackFilesBadge } = useFilesBadge({
    worktree,
    vendor: selectedTask?.vendor ?? DEFAULT_TASK_VENDOR,
    activityMap: transcriptActivity,
  })

  useEffect(() => {
    if (selectedId && tasks.some((task) => task.id === selectedId)) return
    setSelectedId(firstSelectableTask(tasks, activeTaskId)?.id ?? null)
  }, [tasks, activeTaskId, selectedId])

  // PTY lifecycle (issue #16): archiving/deleting a task must end every
  // engine session it owns — its tab PTYs are keyed `taskId::tabId` in the
  // default registry, invisible to the pane once unmounted. Watch the task
  // snapshot and release the corpses; the pane never kills (registry docs),
  // so this is the one place tab shells die with their task.
  const liveTaskIdsRef = useRef<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const next = new Set<string>(tasks.filter((task) => !task.archived).map((task) => task.id))
    const registry = getDefaultPtyRegistry()
    for (const id of liveTaskIdsRef.current) {
      if (!next.has(id)) registry.releaseWhere((key) => key === id || key.startsWith(`${id}::`))
    }
    liveTaskIdsRef.current = next
  }, [tasks])

  function selectTask(id: string): void {
    // Already the selected task → skip the daemon round-trip.
    if (selectedId === id) return
    setSelectedId(id)
    void orch.setActiveTask(id).catch((err) => {
      console.error("[kobe workspace] setActiveTask failed:", err)
    })
  }

  async function activateTask(id: string): Promise<void> {
    const task = tasks.find((tk) => tk.id === id)
    if (!task) return
    if (!task.worktreePath) {
      try {
        await orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe workspace] task.ensureWorktree failed:", err)
        return
      }
    }
    selectTask(id)
    focus.setFocused("workspace")
  }

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
    })

  const setSortMode = (next: "default" | "recent"): void => {
    setSortModeSig(next)
    kv.set("activeSortMode", next)
  }

  // Imperative handle from the currently-mounted TerminalTabs (issue #16
  // editor-tab flow). A ref (not a plain `let` — this component re-renders
  // every state change, unlike Solid's once-per-setup body): FileTree's
  // "open" action only ever READS it at click time, and TerminalTabs
  // re-hands it on every mount (task/worktree switch).
  const openEditorTabFn = useRef<((command: readonly string[], label: string) => void) | null>(null)
  const sendToEngineFn = useRef<((text: string) => void) | null>(null)

  /** FileTree corner `pr` action — the Ops pane's createPR verbatim, with
   *  the tmux send-keys half swapped for a PTY paste+submit. */
  async function createPR(): Promise<void> {
    const wt = worktree
    if (!wt || !sendToEngineFn.current) return
    const prompt = await buildPRPrompt(wt)
    sendToEngineFn.current(prompt)
  }

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
   * a new embedded terminal tab. Falls back to the host-OS opener when no
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

  useWorkspaceKeybindings({
    focus,
    dialog,
    settingsOpen,
    worktreesOpen,
    openWorktrees: () => setWorktreesOpen(true),
    searchActive,
    selectedId,
    openSettings,
    closeSettings,
    createTask: () => void createTask(),
    renameBranch: (id) => void renameBranch(id),
    cycleVendor: (id) => void cycleVendor(id),
  })

  if (worktreesOpen) {
    return <WorktreesPage orchestrator={orch} onClose={() => setWorktreesOpen(false)} />
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
        borderColor={focus.focused === "sidebar" ? theme.focusAccent : theme.border}
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
          focused={focus.focused === "sidebar"}
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
          onLocalMergeRequest={(id) => {
            const task = tasks.find((tk) => tk.id === id)
            if (!task || task.kind === "main") return
            setSelectedId(id)
            setMoveMode((cur) => !cur)
          }}
          sortMode={sortMode}
          onSortModeToggle={() => setSortMode(sortMode === "default" ? "recent" : "default")}
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
        borderColor={focus.focused === "workspace" ? theme.focusAccent : theme.border}
        onMouseUp={() => focus.setFocused("workspace")}
      >
        <ShowWorkspace
          task={selectedTask}
          worktree={worktree}
          orchestrator={orch}
          focused={focus.focused === "workspace"}
          onRequestFocus={() => focus.setFocused("workspace")}
          onEditorTabReady={(open) => {
            openEditorTabFn.current = open
          }}
          onEngineSendReady={(send) => {
            sendToEngineFn.current = send
          }}
        />
      </box>

      {!zen ? (
        <box
          width={worktreeToolsWidth}
          flexShrink={0}
          borderColor={focus.focused === "files" ? theme.focusAccent : theme.border}
          onMouseUp={() => focus.setFocused("files")}
        >
          <FileTree
            worktreePath={worktree}
            focused={focus.focused === "files"}
            onOpenFile={(relPath) => void openFileInEditor(relPath)}
            cornerBadge={filesCornerBadge}
            onRefresh={ackFilesBadge}
            onZenToggle={toggleZen}
            onCreatePR={() => void createPR()}
          />
        </box>
      ) : null}

      <SidebarHoverTooltip hover={sidebarHover} dims={dims} />
    </box>
  )
}

function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: boolean
  onRequestFocus: () => void
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
  onEngineSendReady: (send: (text: string) => void) => void
}): ReactNode {
  const { theme } = useTheme()
  const t = useT()
  const transcriptActivityStore = props.orchestrator.transcriptActivityStore()
  const transcriptActivity = useSyncExternalStore(
    transcriptActivityStore.subscribe,
    transcriptActivityStore.get,
    transcriptActivityStore.get,
  )
  if (!props.worktree) {
    return (
      <box flexGrow={1} alignItems="center" justifyContent="center">
        <text fg={theme.textMuted}>{t("workspace.empty.selectTask")}</text>
      </box>
    )
  }
  const path = props.worktree
  return (
    // The terminal-in-the-middle seam (issue #16): the center column IS
    // the engine — an in-process PTY (Bun.spawn terminal) running the
    // real interactive CLI, so kobe never re-renders the engine's own
    // TUI. `key={path}` remounts per worktree, giving each task its own
    // registry-backed PTY (acquire reuses a live one on switch-back).
    <TerminalTabs
      key={path}
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
      onRequestFocus={props.onRequestFocus}
      onEditorTabReady={props.onEditorTabReady}
      onEngineSendReady={props.onEngineSendReady}
      // This worktree's slice of the daemon transcript.activity push
      // (issue #24) — flips the tab turn-status loops to shared mode.
      sharedActivity={transcriptActivity?.get(path) ?? null}
    />
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
          // Detach, don't kill: daemon-hosted PTYs keep their engine
          // sessions RUNNING in the background and reattach on next boot.
          // Local-backend PTYs (no detach()) are still killed — a child of
          // this process can't outlive it usefully.
          getDefaultPtyRegistry().detachAll()
        },
      }
    },
  })
}
