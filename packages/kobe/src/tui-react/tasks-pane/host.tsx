/** @jsxImportSource @opentui/react */
/**
 * `kobe tasks` — the Tasks pane on the far left of a task's tmux session.
 * React port of `src/tui/tasks-pane/host.tsx` (React is the default runtime
 * since 2026-07-07). agent-deck-style: keep the task list visible inside a
 * tmux Session so you can jump between tasks without detaching to the outer
 * monitor. Reuses the real `Sidebar`; Enter `switch-client`s to a task's
 * session.
 *
 * Solid→React deltas: `RemoteOrchestrator`'s live signals are read in the
 * boot component (`setup.tsx`'s `useAccessor` bridge) and handed to this
 * component as PLAIN VALUES — `tasks`, `activeTaskId`, `uiPrefs`,
 * `liveUpdate`, `engineState`, `taskJobs`, `worktreeChanges`, `daemonStale`,
 * `daemonVersion`, `online` — so nothing here reads a Solid signal in render
 * (the React Sidebar takes plain values too). `createSignal`→`useState`,
 * `createEffect(on(…, untrack(…)))` changed-only follows→`useEffect` diffing
 * against a ref of the current state, `createMemo`→plain derivation,
 * `onCleanup`→effect-return.
 *
 * File-size-cap split (mirrors the Solid original): `tasks-pane/actions.ts`
 * (action bodies + deps bag), `tasks-pane/setup.tsx` (boot wiring + signal
 * bridge), `tasks-pane/shortcut-hints.tsx` (footer legend) — this file keeps
 * `TasksShell` + thin wrappers + `startTasksPane`.
 */

import { currentSessionName, runTmuxCapturing } from "@/tmux/client"
import { ZEN_HIDDEN_PANES_OPTION } from "@/tmux/session-layout"
import { useTerminalDimensions } from "@opentui/react"
import type { UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { useEffect, useRef, useState } from "react"
import type { RemoteOrchestrator, TaskEngineState, TaskJobState } from "../../client/remote-orchestrator.ts"
import {
  archiveTaskFlow,
  cycleVendorFlow,
  deleteTaskFlow,
  renameBranchFlow,
  renameTaskFlow,
} from "../../tui/lib/task-actions"
import { type CreateTaskContext, createTaskFlow } from "../../tui/lib/task-create-flow"
import type { TaskSortMode } from "../../tui/panes/sidebar/groups"
import type { WorktreeChanges } from "../../tui/panes/sidebar/worktree-changes"
import { runLayoutAction } from "../../tui/panes/terminal/layout-actions"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { useLatest } from "../lib/use-latest"
import { Sidebar } from "../panes/sidebar/Sidebar"
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

export type TasksShellProps = {
  tasks: readonly Task[]
  initialTaskId?: string
  /**
   * The shared task-state framework: one daemon-backed RemoteOrchestrator
   * used for every mutation (writes), so the Tasks pane goes through the same
   * single source of truth as the outer monitor. `null` only in the degraded
   * no-daemon fallback, where mutations are unavailable. Reactive READS are
   * bridged in `setup.tsx` and arrive as the plain-value props below.
   */
  orch: RemoteOrchestrator | null
  /** Force an immediate tasks.json re-read after a mutation (poll fallback). */
  reload: () => Promise<void>
  /** True while the daemon socket is the live source (see setup.tsx). */
  online: boolean
  /** Shared active-task focus (`active-task` channel), null with no daemon. */
  activeTaskId: string | null
  /** Latest `ui-prefs` push (sort / project filter / keys-legend fold). */
  uiPrefs: UiPrefsPayload | null
  /** Latest `update` channel push (daemon polls npm), null when none/absent. */
  liveUpdate: UpdateInfo | null
  engineState?: ReadonlyMap<string, TaskEngineState>
  taskJobs?: ReadonlyMap<string, TaskJobState>
  worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  daemonStale: boolean
  daemonVersion: string | null
}

export function TasksShell(props: TasksShellProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const kv = useKV()
  const notif = useNotifications()
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    props.tasks.some((t) => t.id === props.initialTaskId) ? props.initialTaskId! : (props.tasks[0]?.id ?? null),
  )
  // The task id under the Sidebar's CURSOR (its highlighted row), pushed via
  // the Sidebar's onCursorChange. Distinct from `selectedId`: in a home pane
  // `selectedId` follows the active-task channel, but the cursor-row actions
  // (o/b/v) must target whatever row j/k landed on — the same row d/a/r act
  // on. Falls back to `selectedId` before the first cursor push.
  const [cursorId, setCursorId] = useState<string | null>(null)
  const actionTargetId = (): string | null => cursorId ?? selectedId

  // Surface a user-action FAILURE as a red error toast. Under tmux's
  // alternate screen a bare `console.error` is invisible (it only reaches
  // the daemon log), so a failed key press would otherwise look like a
  // silent no-op. We KEEP the matching `console.error` at each call site for
  // log forensics — this is the on-screen half. The notifications context is
  // per-ChatTab (taskId/tabId-keyed); a pane action isn't tab-scoped, so we
  // tag it with the selected task and an empty tab — only the toast queue is
  // consumed here, the unread-dot map is harmless side state we never render.
  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId ?? "", tabId: "", title: message })
  }
  // Neutral (non-error) toast — same on-screen surfacing as notifyError but
  // green/`done` styling, for "this happened" confirmations (engine cycled,
  // creating task, already up to date) that aren't failures.
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId ?? "", tabId: "", title: message })
  }
  const [moveMode, setMoveMode] = useState(false)
  // Sort mode is a GLOBAL pref, fanned out like theme/appearance: the toggle
  // writes `activeSortMode` to state.json, the daemon's ui-prefs watcher sees
  // it and pushes on the `ui-prefs` channel, and the effect below re-applies
  // it here AND in every other session's Tasks pane. Seed from the persisted
  // value so a freshly-spawned pane opens in the user's last sort.
  const [sortMode, setSortMode] = useState<TaskSortMode>(kv.get("activeSortMode") === "recent" ? "recent" : "default")
  const persistedProjectFilter = kv.get("tasksPane.projectFilter")
  const [projectFilter, setProjectFilterSig] = useState<string | null>(
    typeof persistedProjectFilter === "string" && persistedProjectFilter.length > 0 ? persistedProjectFilter : null,
  )
  const setProjectFilter = (repo: string | null) => {
    setProjectFilterSig(repo)
    kv.set("tasksPane.projectFilter", repo)
  }
  // Keep the last non-null update so a later null poll doesn't drop the chip.
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

  // Zen-mode indicator: poll THIS pane's window for `@kobe_zen_panes` (set by
  // the zen-toggle layout action while the ChatTab is collapsed) so the
  // Sidebar can show a `☯ ZEN` badge. No daemon channel for tmux-local layout
  // state, so a cheap 1s poll; no-op with no `$TMUX_PANE`.
  const [zenActive, setZenActive] = useState(false)
  useEffect(() => {
    const pane = process.env.TMUX_PANE
    if (!pane) return
    const pollZen = (): void => {
      void runTmuxCapturing(["show-options", "-wqv", "-t", pane, ZEN_HIDDEN_PANES_OPTION]).then(({ code, stdout }) => {
        setZenActive(code === 0 && stdout.trim().length > 0)
      })
    }
    pollZen()
    const zenTimer = setInterval(pollZen, 1000)
    return () => clearInterval(zenTimer)
  }, [])

  // The Tasks pane OWNS its whole tmux pane (unlike the outer monitor, where
  // the Sidebar is a fixed-width rail). So the embedded Sidebar must FILL the
  // pane — feeding the live terminal width to it makes it reflow to 100% of
  // the pane on every SIGWINCH-driven resize.
  const dimensions = useTerminalDimensions()

  // Shared active-task focus is followed ONLY by a HOME pane (no
  // initialTaskId) — the navigational surface where selecting a row IS the
  // focus. A pane SPAWNED for a task session pins its highlight to that one
  // task instead: following shared focus made it LIE (a sibling click left
  // this backgrounded pane's highlight on the sibling while its chat still
  // showed its own task).
  useEffect(() => {
    if (props.initialTaskId) return
    if (props.activeTaskId) setSelectedId(props.activeTaskId)
  }, [props.activeTaskId, props.initialTaskId])

  // Visual prefs apply centrally via host-boot's UiPrefsSync. Sort mode +
  // project filter ride the SAME `ui-prefs` channel but are pane-state, so
  // this pane follows them here: a toggle in ANY session pushes and
  // re-applies here too. Changed-only assignment (diff against the live refs)
  // makes our own write's echo a no-op.
  const sortModeRef = useLatest(sortMode)
  const projectFilterRef = useLatest(projectFilter)
  useEffect(() => {
    const payload = props.uiPrefs
    if (!payload) return
    if (payload.sortMode !== sortModeRef.current) setSortMode(payload.sortMode)
    if (payload.projectFilter !== projectFilterRef.current) setProjectFilterSig(payload.projectFilter)
  }, [props.uiPrefs])

  // Update info comes from the daemon-owned `update` channel; keep the last
  // non-null value so a later null poll doesn't drop the chip.
  useEffect(() => {
    if (props.liveUpdate) setUpdateInfo(props.liveUpdate)
  }, [props.liveUpdate])

  // Deps bag for every action in `tasks-pane/actions.ts` (file-size cap) —
  // built once per render. Thin wrappers below keep every JSX prop /
  // keybinding call site unchanged.
  const actionsCtx: TasksHostActionsContext = {
    tasks: () => props.tasks,
    orch: props.orch,
    kv,
    dialog,
    notifyError,
    notifyInfo,
    reload: () => props.reload(),
    updateInfo: () => updateInfo,
    setSelectedId,
  }
  // Monotonic switch-token holder — one mutable ref per TasksShell instance
  // (genuinely local mutable state, not React reactive state).
  const switchRef = useRef<SwitchToRef>({ token: 0 }).current
  const switchTo = (id: string): Promise<void> => switchToAction(actionsCtx, switchRef, id)

  // Shared task-action context (lib/task-actions): the flow bodies (confirm
  // copy, DIRTY_WORKTREE force-delete branch, error handling) live in that
  // shared module so this pane and the deprecated outer monitor can't drift
  // apart; `buildTaskActionsContext` supplies only what's genuinely this
  // host's (dialog wiring, toast surfacing, disk-only persistence, the
  // chattab create surface, and selection).
  const taskActions: CreateTaskContext = buildTaskActionsContext({
    ...actionsCtx,
    selectedId: () => selectedId,
    setSelectedId,
    switchTo,
  })

  // `n` creates a new task using the SAME NewTaskDialog (and createTaskFlow)
  // as the outer app — parity matters; this pane replaces the outer "page 1".
  async function createTask(): Promise<void> {
    await createTaskFlow(taskActions)
  }
  async function archiveTask(id: string): Promise<void> {
    await archiveTaskFlow(taskActions, id)
  }
  async function deleteTask(id: string): Promise<void> {
    await deleteTaskFlow(taskActions, id)
  }
  // Rename a task's title via `task.rename` (same flow the outer app's `r`
  // uses). No pane zoom — the dialog shows in place.
  async function renameTask(id: string): Promise<void> {
    await renameTaskFlow(taskActions, id)
  }
  // Rename a task's branch via `task.setBranch` (`b`).
  async function renameBranch(id: string): Promise<void> {
    await renameBranchFlow(taskActions, id)
  }
  // Cycle the cursor task's engine vendor (`v`) via `task.setVendor`.
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

  // Collapsed state of the `── keys ──` legend (toggled by `?` / clicking the
  // header). A GLOBAL pref fanned out like sort/theme: seed from the persisted
  // value, apply locally for instant feedback, and persist via kv so the
  // daemon's ui-prefs watcher re-folds the legend in EVERY other session's
  // Tasks pane (the follow effect below).
  const [keysCollapsed, setKeysCollapsedSig] = useState<boolean>(kv.get("tasksPane.keysCollapsed", false) === true)
  const setKeysCollapsed = (next: boolean) => {
    setKeysCollapsedSig(next)
    kv.set("tasksPane.keysCollapsed", next)
  }
  // Follow the broadcast: a `?` toggle in another session re-folds this
  // legend too. Changed-only (diff against the live ref), so our own write's
  // echo is a no-op.
  const keysCollapsedRef = useLatest(keysCollapsed)
  useEffect(() => {
    const payload = props.uiPrefs
    if (!payload) return
    if (payload.keysCollapsed !== keysCollapsedRef.current) setKeysCollapsedSig(payload.keysCollapsed)
  }, [props.uiPrefs])

  // The sidebar's `/`-search lifts its active state here so the host-level
  // plain-letter chords below go quiet while the user is TYPING a query —
  // without this gate, typing `n` into the search box would open the new-task
  // dialog (the sidebar de-registers its OWN letter chords during search but
  // can't reach ours).
  const [searchActive, setSearchActive] = useState(false)

  // Gate on an empty dialog stack so a letter typed INTO a dialog field
  // doesn't re-fire the binding (the keymap sees inline-input keystrokes; the
  // dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !searchActive,
    // Chords come from KobeKeymap via bindByIds (f1=help.open, n=task.new,
    // s=settings.open.sidebar, w=worktrees.open.sidebar, u=tasks.update,
    // o/b/v=tasks.*) so user overrides from ~/.kobe/settings/keybindings.yaml
    // apply here too. Gated on an empty dialog stack so it doesn't `replace`
    // an open dialog.
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
      "tasks.toggleKeys": () => setKeysCollapsed(!keysCollapsed),
      // Fire-and-forget with an explicit catch — this pane process has no
      // crash net, so a rejection must not become an unhandled one.
      "tasks.focusEngine": () =>
        void focusEnginePane().catch((err) => console.error("[kobe tasks] focus engine pane failed:", err)),
    }),
  }))

  // Version / update chip for the Sidebar's brand header. Emphasised +
  // clickable (opens the update page) when an update is waiting, otherwise a
  // quiet version label.
  const headerStatus = updateInfo?.hasUpdate
    ? { label: `v${updateInfo.latest} ↑`, emphasize: true }
    : { label: `v${CURRENT_VERSION}`, emphasize: false }

  // Whether the cursor row is a `main` (project root) task. The branch (`B`)
  // and move (`M`) actions early-return on a main row, so the footer dims
  // those keycaps to signal "doesn't apply here".
  const selectedIsMain = props.tasks.find((t) => t.id === selectedId)?.kind === "main"

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.backgroundPanel}>
      <VersionSkewBanner
        stale={props.daemonStale}
        daemonVersion={props.daemonVersion}
        clientVersion={CURRENT_VERSION}
        width={dimensions.width}
      />
      <box flexGrow={1} flexShrink={1}>
        <Sidebar
          tasks={props.tasks}
          selectedId={selectedId}
          // A task-bound pane pins its highlight to its OWN task: picking
          // another row JUMPS to it (onActivate → switchTo) without repointing
          // this pane's persistent selection. The home pane selects normally.
          onSelect={props.initialTaskId ? () => {} : setSelectedId}
          // A task-bound pane pins its selection (onSelect no-ops): tell the
          // Sidebar so a jump-away click/Enter snaps the cursor back to the
          // pinned row instead of stranding it on the jumped-to project.
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
          // Fill the whole tmux pane and follow live resizes.
          width={dimensions.width}
          engineState={props.engineState}
          taskJobs={props.taskJobs}
          // Daemon-collected `+N −M` counts, gated on the LIVE connection in
          // setup.tsx: a daemon idle-stop / restart flips this to null so the
          // Sidebar's local poller takes over instead of freezing on the last
          // pushed counts.
          worktreeChanges={props.worktreeChanges}
          onRenameRequest={(id) => void renameTask(id)}
          onDeleteRequest={(id) => void deleteTask(id)}
          onArchiveRequest={(id) => void archiveTask(id)}
          onPinRequest={(id) => void togglePin(id)}
          onPreviewToggleRequest={(id) => void togglePreviewFlow(id)}
          onLocalMergeRequest={(id) => {
            const task = props.tasks.find((t) => t.id === id)
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
            const next: TaskSortMode = sortMode === "default" ? "recent" : "default"
            // Apply locally for instant feedback, then persist — the kv write
            // lands in state.json and the daemon's ui-prefs watcher fans it
            // out to every other session's Tasks pane (global sort).
            setSortMode(next)
            kv.set("activeSortMode", next)
          }}
          // Gate the Sidebar's own bindings (Enter→switchTo, j/k, …) on an
          // empty dialog stack — otherwise Enter pressed to submit a dialog
          // leaks past the input to switchTo and yanks you into a task.
          focused={dialog.stack.length === 0}
          onSearchActiveChange={setSearchActive}
          // Track the cursor row so the host-scoped o/b/v chords act on the
          // highlighted task (like d/a/r), not on the active-task-following
          // `selectedId`.
          onCursorChange={setCursorId}
        />
      </box>
      <ShortcutHints
        moveMode={moveMode}
        selectedIsMain={selectedIsMain}
        collapsed={keysCollapsed}
        onToggleCollapsed={() => setKeysCollapsed(!keysCollapsed)}
      />
    </box>
  )
}

export async function startTasksPane(opts: { initialTaskId?: string } = {}): Promise<void> {
  await bootPaneHost({
    logContext: "tasks",
    // Notifications power the bottom-right error toasts: under tmux's
    // alternate screen a failed action's `console.error` is invisible (daemon
    // log only), so a rejected key press surfaces as a red chip here instead
    // of looking like a silent no-op. `kv` is opted in explicitly (React
    // host-boot defaults it FALSE, unlike the Solid host which mounted it for
    // every pane) — the pane persists sort / project-filter / keys-fold prefs.
    providers: { kv: true, notifications: true },
    setup: () => setupTasksPane(opts),
  })
}
