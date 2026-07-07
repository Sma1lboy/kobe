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
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { latestTranscriptMtime } from "../../monitor/activity.ts"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "../../state/vendor-prefs.ts"
import { resolveEditorLaunch } from "../../tmux/editor-launch.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import { HelpDialog } from "../component/help-dialog"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { WorktreesPage } from "../component/worktrees-page"
import { type PaneId, useFocus } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
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
import { startLocalBadgePoll } from "../ops/activity-monitor"
import { buildPRPrompt } from "../ops/pr-prompt"
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
// Slot 3 (ctrl+l — "terminal" in the 4-pane model) maps back to workspace:
// this host is 3-pane and its middle column IS the terminal, so ctrl+l
// would otherwise be a dead key for anyone with tmux-layer muscle memory.
const PANE_BY_SLOT = ["sidebar", "workspace", "files", "workspace"] as const satisfies readonly PaneId[]
// Cycle order for focus.next/prev — the host's real panes, NOT the
// context's PANE_ORDER: that includes "terminal", which this host never
// mounts, and cycling focus onto an unmounted pane would strand it.
const PANE_CYCLE = ["sidebar", "workspace", "files"] as const satisfies readonly PaneId[]

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

  /* --------- files-column activity badge (issue #21) -------------------
   * The Ops pane's `● new` transcript badge, absorbed into the files
   * column: baseline seeds at "now's newest" so mounting onto a busy task
   * doesn't flash stale activity; FileTree's refresh (`r`) is the "I've
   * looked" ack. Source is the daemon's transcript.activity push, with
   * the Ops pane's exact local-mtime fallback when no daemon data. */
  const sharedActivityMap = () => props.orchestrator.transcriptActivitySignal()() ?? null
  const [badgeBaseline, setBadgeBaseline] = createSignal(0)
  const [badgeLatest, setBadgeLatest] = createSignal(0)
  const [badgePrimed, setBadgePrimed] = createSignal(false)
  createEffect(
    on(worktree, () => {
      setBadgePrimed(false)
      setBadgeBaseline(0)
      setBadgeLatest(0)
    }),
  )
  createEffect(() => {
    const wt = worktree()
    const map = sharedActivityMap()
    if (!wt || !map) return
    const mtime = map.get(wt)?.mtimeMs ?? 0
    if (!badgePrimed() && mtime > 0) {
      setBadgePrimed(true)
      setBadgeBaseline(mtime)
    }
    setBadgeLatest(mtime)
  })
  createEffect(() => {
    const wt = worktree()
    if (!wt || sharedActivityMap() !== null) return
    const vendor = selectedTask()?.vendor ?? DEFAULT_TASK_VENDOR
    onCleanup(
      startLocalBadgePoll(
        // In-process host: no tmux attach gate (the pane is visible iff
        // the app runs), only the engine-owned transcript mtime probe.
        { sessionAttached: async () => true, latestMtime: () => latestTranscriptMtime(vendor, wt) },
        {
          isPrimed: () => badgePrimed(),
          prime: (mtime) => {
            setBadgePrimed(true)
            setBadgeBaseline(mtime)
          },
          setLatest: setBadgeLatest,
        },
      ),
    )
  })
  const filesCornerBadge = () =>
    badgePrimed() && badgeLatest() > badgeBaseline() ? { text: t("ops.badge.newActivity"), active: true } : null

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

  // The SAME shared task-action flows the tmux Tasks pane runs
  // (lib/task-actions — confirm copy, DIRTY_WORKTREE force-delete branch,
  // error handling live there so hosts can't drift). What's built here is
  // only this host's genuine divergences: dialog wiring, toast surfacing,
  // and selection. No `switchBeforeKill` (no tmux client to yank), no
  // `openCreateSurface` (no tmux tab to open — the in-pane NewTaskDialog
  // IS the surface), no `reload` (this host is fully signal-driven).
  const taskActions: CreateTaskContext = {
    orch: props.orchestrator,
    tasks: () => tasks(),
    confirm: async (p) => (await DialogConfirm.show(dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    promptText: (initial, opts) => RenameTaskDialog.show(dialog, initial, opts),
    logger: console,
    logPrefix: "[kobe workspace]",
    notifyError,
    notifyInfo,
    updateActiveTask: true,
    onTaskDeleted: (taskId, nextTask) => {
      if (selectedId() !== taskId) return
      const remaining = tasks()
      setSelectedId(nextTask?.id ?? (remaining.find((task) => !task.archived) ?? remaining[0])?.id ?? null)
    },
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(dialog, defaultRepo, repos, opts),
    cursorRepo: () => selectedTask()?.repo ?? tasks()[0]?.repo,
    lastVendor: (repo) => resolvePreferredVendor(repo),
    rememberVendor: (repo, vendor) => setRepoLastActiveVendor(repo, vendor),
    selectTask: (id) => setSelectedId(id),
    enterTask: (id) => activateTask(id),
  }

  const createTask = (): Promise<void> => createTaskFlow(taskActions)
  const archiveTask = (id: string): Promise<void> => archiveTaskFlow(taskActions, id)
  const deleteTask = (id: string): Promise<void> => deleteTaskFlow(taskActions, id)
  const renameTask = (id: string): Promise<void> => renameTaskFlow(taskActions, id)
  const renameBranch = (id: string): Promise<void> => renameBranchFlow(taskActions, id)
  const cycleVendor = (id: string): Promise<void> => cycleVendorFlow(taskActions, id)

  async function togglePin(id: string): Promise<void> {
    const task = tasks().find((t) => t.id === id)
    if (!task) return
    await props.orchestrator.setPinned(id, !task.pinned).catch((err) => {
      notifyError(`Couldn't pin: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function moveTask(id: string, delta: -1 | 1): Promise<void> {
    await props.orchestrator.moveTask(id, delta).catch((err) => {
      notifyError(`Couldn't move: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const setSortMode = (next: "default" | "recent"): void => {
    // Apply locally for instant feedback, then persist — the kv write lands
    // in state.json and fans out to every other session's Tasks pane.
    setSortModeSig(next)
    kv.set("activeSortMode", next)
  }

  /**
   * Restore the terminal BEFORE exiting — a bare process.exit leaves mouse
   * tracking / kitty keyboard on, spraying `35;66;18M`-style junk into the
   * user's shell. destroy() also runs the render options' onDestroy
   * (orchestrator dispose). Same shape as settings-dialog/actions.ts.
   */
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

  function cyclePane(delta: 1 | -1): void {
    const idx = PANE_CYCLE.indexOf(focus.focused() as (typeof PANE_CYCLE)[number])
    const next = (idx + delta + PANE_CYCLE.length) % PANE_CYCLE.length
    focus.setFocused(PANE_CYCLE[next] as PaneId)
  }

  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && !worktreesOpen(),
    bindings: [
      ...bindByIds({
        "help.open": () => HelpDialog.show(dialog),
        "focus.numeric": (_evt, slot) => {
          const pane = PANE_BY_SLOT[slot ?? 0]
          if (pane) focus.setFocused(pane)
        },
        // f4 — reserved from terminal passthrough, so the cycle behaves
        // identically from every pane including inside the terminal.
        // Deliberately not tab/shift+tab (engine completion / plan-mode);
        // see the keymap row comment. Forward-only.
        "focus.next": () => cyclePane(1),
      }),
    ],
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && !worktreesOpen() && !focus.is("sidebar")(),
    bindings: bindByIds({
      "focus.sidebar": () => focus.setFocused("sidebar"),
    }),
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && !worktreesOpen() && focus.is("sidebar")(),
    bindings: bindByIds({
      // Slot dispatch (SLOT_CONTRACTS): slot 0 = quit confirm, slot 1 =
      // hard exit — so user rebinds keep both verbs without inspecting
      // the event's modifiers.
      "app.quit": (_evt, slot) => {
        if (slot === 1) {
          exitApp()
          return
        }
        void quit()
      },
      "settings.open.sidebar": () => openSettings(),
      "worktrees.open.sidebar": () => setWorktreesOpen(true),
    }),
  }))
  // Task-lifecycle chords (issue #20 — the tmux Tasks pane's n/b/v set).
  // d/a/r/pin/move fire from the Sidebar's OWN keys via the Request props
  // below; these three are host-scoped in both hosts. Gated on sidebar
  // focus + no dialog + search inactive (typing `n` into the search box
  // must not open the new-task dialog — same chord-leak class).
  useBindings(() => ({
    enabled:
      dialog.stack.length === 0 && !settingsOpen() && !worktreesOpen() && focus.is("sidebar")() && !searchActive(),
    bindings: bindByIds({
      "task.new": () => void createTask(),
      "tasks.renameBranch": () => {
        const id = selectedId()
        if (id) void renameBranch(id)
      },
      "tasks.cycleEngine": () => {
        const id = selectedId()
        if (id) void cycleVendor(id)
      },
      // Right arrow — the tmux Tasks pane's "go right into the engine"
      // gesture (tasks.focusEngine), same row, pure-TUI equivalent: focus
      // the workspace terminal. Gated on search-inactive (this group), so
      // Right while typing a query keeps moving the input cursor.
      "tasks.focusEngine": () => focus.setFocused("workspace"),
    }),
  }))
  // Page-level close keys for the settings swap — mirrors settings/host.tsx's
  // standalone page (no enclosing dialog stack to own esc/Ctrl+C, so the
  // page binds them itself; gated on an empty dialog stack so a sub-dialog,
  // e.g. the engine-command editor, keeps esc/typing for itself).
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
                onRefresh={() => setBadgeBaseline(badgeLatest())}
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
