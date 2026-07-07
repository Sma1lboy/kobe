/**
 * Experimental native opentui workspace (`KOBE_TUI=1`).
 *
 * Single-process app: Sidebar | engine Terminal | Files. The center column
 * is the terminal-in-the-middle seam (issue #16) — an in-process PTY
 * running the task's real interactive engine CLI (claude/codex), so kobe
 * wraps the engine's own TUI instead of re-rendering its stream. The
 * default product path stays the tmux handover while this proves out.
 */

import { join } from "node:path"
import { useTerminalDimensions } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { resolveEditorLaunch } from "../../tmux/editor-launch.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import { SettingsDialog } from "../component/settings-dialog"
import { WorktreesPage } from "../component/worktrees-page"
import { useFocus } from "../context/focus"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { buildPRPrompt } from "../ops/pr-prompt"
import { FileTree } from "../panes/filetree/FileTree"
import { openExternally } from "../panes/filetree/open-external"
import { Sidebar, type SidebarHover } from "../panes/sidebar/Sidebar"
import { SidebarHoverTooltip } from "../panes/sidebar/hover-tooltip"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import { TerminalTabs } from "./TerminalTabs"
import { useFilesBadge } from "./files-badge"
import { useWorkspaceKeybindings } from "./host-keybindings"
import { useWorkspaceTaskActions } from "./host-task-actions"

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
  const [selectedId, setSelectedId] = createSignal<string | null>(props.orchestrator.activeTaskSignal()())
  const [sidebarHover, setSidebarHover] = createSignal<SidebarHover | null>(null)
  // Task-lifecycle UI state (issue #20 — parity with the tmux Tasks pane):
  // move mode (m + arrows reorder), the global sort preference (kv-fanned
  // like theme), the project filter, and the sidebar-search gate that mutes
  // host letter chords while the user types a query.
  const [moveMode, setMoveMode] = createSignal(false)
  const [sortMode, setSortModeSig] = createSignal<"default" | "recent">(
    kv.get("activeSortMode", "default") === "recent" ? "recent" : "default",
  )
  const [projectFilter, setProjectFilter] = createSignal<string | null>(null)
  const [searchActive, setSearchActive] = createSignal(false)

  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId() ?? "", tabId: "", title: message })
  }
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId() ?? "", tabId: "", title: message })
  }

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

  // Files-column activity badge (issue #21) — the `● new` transcript badge
  // + its refresh-as-ack, extracted to `files-badge.ts` (file-size cap).
  const { cornerBadge: filesCornerBadge, ackRefresh: ackFilesBadge } = useFilesBadge({
    worktree,
    vendor: () => selectedTask()?.vendor ?? DEFAULT_TASK_VENDOR,
    activityMap: () => props.orchestrator.transcriptActivitySignal()() ?? null,
  })

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

  // PTY lifecycle (issue #16): archiving/deleting a task must end every
  // engine session it owns — its tab PTYs are keyed `taskId::tabId` in the
  // default registry, invisible to the pane once unmounted. Watch the task
  // snapshot and release the corpses; the pane never kills (registry docs),
  // so this is the one place tab shells die with their task.
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

  // Task-action callbacks (new/archive/delete/rename/branch/engine/pin/move)
  // — the CreateTaskContext + shared lib/task-actions flows live in
  // host-task-actions.ts (file-size cap).
  const { createTask, archiveTask, deleteTask, renameTask, renameBranch, cycleVendor, togglePin, moveTask } =
    useWorkspaceTaskActions({
      orchestrator: props.orchestrator,
      tasks: () => tasks(),
      dialog,
      notifyError,
      notifyInfo,
      selectedId,
      setSelectedId,
      selectedTask,
      activateTask,
    })

  const setSortMode = (next: "default" | "recent"): void => {
    // Apply locally for instant feedback, then persist — the kv write lands
    // in state.json and fans out to every other session's Tasks pane.
    setSortModeSig(next)
    kv.set("activeSortMode", next)
  }

  // Imperative handle from the currently-mounted TerminalTabs (issue #16
  // editor-tab flow) — a plain ref, not a signal: FileTree's "open" action
  // only ever READS it at click time, and TerminalTabs re-hands it on every
  // mount (task/worktree switch), so there's nothing to react to here.
  let openEditorTabFn: ((command: readonly string[], label: string) => void) | null = null
  // Same contract for "paste into the active engine tab + submit" — the
  // FileTree corner Create-PR action (Ops-pane parity).
  let sendToEngineFn: ((text: string) => void) | null = null

  /** FileTree corner `pr` action — the Ops pane's createPR verbatim, with
   *  the tmux send-keys half swapped for a PTY paste+submit. */
  async function createPR(): Promise<void> {
    const wt = worktree()
    if (!wt || !sendToEngineFn) return
    const prompt = await buildPRPrompt(wt)
    sendToEngineFn(prompt)
  }

  /* --------- zen mode (issue #18, pure-tui shape) -----------------------
   * Matches the tmux zen contract: hide the FILES
   * column, keep the Tasks sidebar visible (tmux keeps it per the
   * zenKeepTasks setting — hardcoded keep here for now), terminal takes
   * the freed width. Entering pulls focus to the terminal; the way out is
   * the sidebar's ☯ ZEN chip, or focusing the hidden files pane (slot 3)
   * which auto-exits — a hidden pane must never hold focus. Mouse-driven
   * for v1; no new chord, so no KEYBINDINGS.md entry needed yet. */
  const [zen, setZen] = createSignal(false)
  function toggleZen(): void {
    const next = !zen()
    setZen(next)
    if (next) focus.setFocused("workspace")
  }
  createEffect(() => {
    if (focus.is("files")()) setZen(false)
  })

  /**
   * FileTree's Enter action (issue #16 editor-tab flow) — the puretui
   * equivalent of tmux's Ops-pane `openInEditor`: resolve the user's real
   * editor (with the nvim/vim diff-mode upgrade when the file differs from
   * HEAD) via the SAME tmux-agnostic command builder
   * (`tmux/editor-launch.ts`'s `resolveEditorLaunch`), then run it in a new
   * embedded terminal tab instead of a tmux window. Falls back to the
   * host-OS opener (same as the FileTree `o` key) when no editor is
   * configured/installed — there's no in-TUI read-only preview here (tmux's
   * `kobe ops --preview` full CLI subcommand is out of scope for this pass).
   *
   * Focus: opening an INTERACTIVE editor tab pulls focus to the workspace
   * (an editor you can't type into is broken), in
   * deliberate contrast to the no-focus-pull rule, which applies to
   * read-only content swaps (previews), not to spawned editors.
   */
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
    focus.setFocused("workspace")
  }

  // Full-page swap — like the tmux `chattab` surface opening a dedicated
  // `kobe settings` window, not an overlay dialog stacked over the 3-pane
  // row. This single process has no tmux window to spawn into, so the
  // page swap happens in place: `settingsOpen` replaces the whole layout,
  // same as tmux switching to the settings window. Theme/transparent/focus
  // accent changes apply centrally via host-boot's UiPrefsSync, so there's
  // no workspace-pane refresh to trigger on close.
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  function openSettings(): void {
    setSettingsOpen(true)
  }
  function closeSettings(): void {
    setSettingsOpen(false)
  }
  // Worktrees page (issue #23) — same in-place swap as settings, standing
  // in for tmux's dedicated `kobe worktrees` window. The page owns its own
  // close keys (q/esc) via onClose.
  const [worktreesOpen, setWorktreesOpen] = createSignal(false)

  // Pane focus, quit/exit, task-lifecycle chords, and the settings-page
  // close keys — the four useBindings blocks live in host-keybindings.ts
  // (file-size cap); every handler is a host closure passed through.
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

  return (
    <Show
      when={!worktreesOpen()}
      fallback={<WorktreesPage orchestrator={props.orchestrator} onClose={() => setWorktreesOpen(false)} />}
    >
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
          {/* Tasks sidebar stays visible in zen (tmux parity) — its
              ☯ ZEN chip is also the exit affordance. */}
          <box
            width={SIDEBAR_WIDTH}
            flexShrink={0}
            borderColor={focus.is("sidebar")() ? theme.focusAccent : theme.border}
            onMouseUp={() => focus.setFocused("sidebar")}
          >
            <Sidebar
              // The host box is SIDEBAR_WIDTH *including* its 2 border cells;
              // without this, Sidebar's imperative self-width (32) overflows the
              // inner 30 and the cursor row's background paints over the border.
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
                const task = tasks().find((t) => t.id === id)
                if (!task || task.kind === "main") return
                setSelectedId(id)
                setMoveMode((cur) => !cur)
              }}
              sortMode={sortMode}
              onSortModeToggle={() => setSortMode(sortMode() === "default" ? "recent" : "default")}
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
            borderColor={focus.is("workspace")() ? theme.focusAccent : theme.border}
            onMouseUp={() => focus.setFocused("workspace")}
          >
            <ShowWorkspace
              task={selectedTask()}
              worktree={worktree()}
              orchestrator={props.orchestrator}
              focused={focus.is("workspace")}
              onRequestFocus={() => focus.setFocused("workspace")}
              onEditorTabReady={(open) => {
                openEditorTabFn = open
              }}
              onEngineSendReady={(send) => {
                sendToEngineFn = send
              }}
            />
          </box>

          <Show when={!zen()}>
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
                // Ops-pane absorption (issue #21): the `● new` transcript badge
                // + its refresh-as-ack, same contract as ops/host.tsx.
                cornerBadge={filesCornerBadge}
                onRefresh={ackFilesBadge}
                // Ops-pane corner actions: zen + PR.
                onZenToggle={toggleZen}
                onCreatePR={() => void createPR()}
              />
            </box>
          </Show>

          <SidebarHoverTooltip hover={sidebarHover} dims={dims} />
        </box>
      </Show>
    </Show>
  )
}

function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: () => boolean
  onRequestFocus: () => void
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
  onEngineSendReady: (send: (text: string) => void) => void
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
        // The terminal-in-the-middle seam (issue #16): the center column IS
        // the engine — an in-process PTY (Bun.spawn terminal) running the
        // real interactive CLI, so kobe never re-renders the engine's own
        // TUI. `keyed` remounts per worktree, giving each task its own
        // registry-backed PTY (acquire reuses a live one on switch-back).
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
          onRequestFocus={props.onRequestFocus}
          onEditorTabReady={props.onEditorTabReady}
          onEngineSendReady={props.onEngineSendReady}
          // This worktree's slice of the daemon transcript.activity push
          // (issue #24) — flips the tab turn-status loops to shared mode.
          sharedActivity={() => props.orchestrator.transcriptActivitySignal()()?.get(path) ?? null}
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
          // End every embedded engine/shell PTY with the app — the exit
          // backstop only covers the host process; the PTY children are
          // process-group members that must be killed explicitly.
          getDefaultPtyRegistry().releaseAll()
        },
      }
    },
  })
}
