/**
 * `kobe tasks` — the experimental Tasks pane on the far left of a task's
 * tmux session. agent-deck-style: keep the task list visible
 * inside a tmux Session so you can jump between tasks without detaching to
 * the outer monitor. Reuses the real `Sidebar`; Enter `switch-client`s to
 * a task's session.
 *
 * Scope (deliberately minimal): reads `~/.kobe/tasks.json` + re-reads on a
 * timer as a fallback (the daemon-backed RemoteOrchestrator subscribe is
 * primary — see `setup.tsx`). `r`/`b`/`v` rename title/branch/cycle engine
 * via daemon RPCs. `n` opens the same NewTaskDialog + `task.create` RPC as
 * the outer app. Enter/click lazily creates the session (`ensureSession`,
 * materialising the worktree first if needed) then switches to it.
 *
 * File-size-cap split: `tasks-pane/actions.ts` (action bodies, deps-bag
 * template), `tasks-pane/setup.tsx` (boot wiring), `tasks-pane/shortcut-hints.tsx`
 * (the footer legend) — this file keeps `TasksShell` + thin wrappers.
 */

import { currentSessionName, runTmuxCapturing } from "@/tmux/client"
import { ZEN_HIDDEN_PANES_OPTION } from "@/tmux/session-layout"
import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import type { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import type { Task } from "../../types/task.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
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
import { Sidebar } from "../panes/sidebar/Sidebar"
import type { TaskSortMode } from "../panes/sidebar/groups"
import { runLayoutAction } from "../panes/terminal/layout-actions.ts"
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

export function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  initialTaskId?: string
  /**
   * The shared task-state framework: one daemon-backed RemoteOrchestrator
   * used for BOTH the live subscribe (reads) and every mutation (writes),
   * so the Tasks pane goes through the same single source of truth as the
   * outer monitor — no ad-hoc per-op clients. `null` only in the
   * degraded no-daemon fallback, where mutations are unavailable.
   */
  orch: RemoteOrchestrator | null
  /** Force an immediate tasks.json re-read after a mutation (poll fallback). */
  reload: () => Promise<void>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const kv = useKV()
  const notif = useNotifications()
  const [selectedId, setSelectedId] = createSignal<string | null>(
    props.tasks().some((t) => t.id === props.initialTaskId) ? props.initialTaskId! : (props.tasks()[0]?.id ?? null),
  )
  // The task id under the Sidebar's CURSOR (its highlighted row), pushed via
  // the Sidebar's onCursorChange. Distinct from `selectedId`: in a home pane
  // `selectedId` follows the active-task channel, but the cursor-row actions
  // (o/b/v) must target whatever row j/k landed on — the same row d/a/r act
  // on. Falls back to `selectedId()` before the first cursor push.
  const [cursorId, setCursorId] = createSignal<string | null>(null)
  const actionTargetId = (): string | null => cursorId() ?? selectedId()

  // Surface a user-action FAILURE as a red error toast. Under tmux's
  // alternate screen a bare `console.error` is invisible (it only reaches
  // the daemon log), so a failed key press would otherwise look like a
  // silent no-op. We KEEP the matching `console.error` at each call site for
  // log forensics — this is the on-screen half. The notifications context is
  // per-ChatTab (taskId/tabId-keyed); a pane action isn't tab-scoped, so we
  // tag it with the selected task and an empty tab — only the toast queue is
  // consumed here, the unread-dot map is harmless side state the Tasks pane
  // never renders.
  function notifyError(message: string): void {
    notif.notify({ kind: "error", taskId: selectedId() ?? "", tabId: "", title: message })
  }
  // Neutral (non-error) toast — same on-screen surfacing as notifyError but
  // green/`done` styling, for "this happened" confirmations (engine cycled,
  // creating task, already up to date) that aren't failures.
  function notifyInfo(message: string): void {
    notif.notify({ kind: "done", taskId: selectedId() ?? "", tabId: "", title: message })
  }
  const [moveMode, setMoveMode] = createSignal(false)
  // Sort mode is a GLOBAL pref, fanned out like theme/appearance: the toggle
  // writes `activeSortMode` to state.json (below), the daemon's ui-prefs
  // watcher sees the change and pushes it on the `ui-prefs` channel, and the
  // effect below re-applies it here AND in every other session's Tasks pane.
  // Seed from the persisted value so a freshly-spawned pane opens in the
  // user's last sort, not always `default` (no-flash + no-daemon fallback).
  const [sortMode, setSortMode] = createSignal<TaskSortMode>(
    kv.get("activeSortMode") === "recent" ? "recent" : "default",
  )
  const persistedProjectFilter = kv.get("tasksPane.projectFilter")
  const [projectFilter, setProjectFilterSig] = createSignal<string | null>(
    typeof persistedProjectFilter === "string" && persistedProjectFilter.length > 0 ? persistedProjectFilter : null,
  )
  const setProjectFilter = (repo: string | null) => {
    setProjectFilterSig(repo)
    kv.set("tasksPane.projectFilter", repo)
  }
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)

  // Zen-mode indicator: poll THIS pane's window for `@kobe_zen_panes` (set
  // by the zen-toggle layout action while the ChatTab is collapsed) so the
  // Sidebar can show a `☯ ZEN` badge. No daemon channel for tmux-local
  // layout state, so a cheap 1s poll; no-op with no `$TMUX_PANE`.
  const [zenActive, setZenActive] = createSignal(false)
  {
    const pane = process.env.TMUX_PANE
    if (pane) {
      const pollZen = (): void => {
        void runTmuxCapturing(["show-options", "-wqv", "-t", pane, ZEN_HIDDEN_PANES_OPTION]).then(
          ({ code, stdout }) => {
            setZenActive(code === 0 && stdout.trim().length > 0)
          },
        )
      }
      pollZen()
      const zenTimer = setInterval(pollZen, 1000)
      onCleanup(() => clearInterval(zenTimer))
    }
  }

  // The Tasks pane OWNS its whole tmux pane (unlike the outer monitor, where the
  // Sidebar is a fixed-width rail beside the workspace). So the embedded Sidebar
  // must FILL the pane, not sit at its default 32-cell rail width — otherwise
  // dragging the tmux split wider just leaves dead space to the right. opentui's
  // renderer tracks the pane size (SIGWINCH → onResize), so feeding the live
  // terminal width to the Sidebar's width accessor makes it reflow to 100% of the
  // pane on every resize.
  const dimensions = useTerminalDimensions()

  // Shared active-task focus (`active-task` channel) is followed
  // ONLY by a HOME pane (no initialTaskId) — the navigational surface where
  // selecting a row IS the focus. A pane SPAWNED for a task session pins its
  // highlight to that one task instead: following shared focus made it LIE
  // (a sibling click left this backgrounded pane's highlight on the sibling
  // while its chat still showed its own task) — entering another task from
  // there is a jump (switchTo), not a re-selection of THIS pane.
  createEffect(() => {
    if (props.initialTaskId) return
    const active = props.orch?.activeTaskSignal()()
    if (!active) return
    setSelectedId(active)
  })

  // Visual prefs apply centrally via host-boot's UiPrefsSync. Sort mode +
  // project filter ride the SAME `ui-prefs` channel but are pane-state, so
  // this pane follows them here: a toggle in ANY session pushes and
  // re-applies here too. Changed-only assignment makes our own write's
  // echo a no-op. (Keys-legend fold effect lives by its own signal below.)
  createEffect(
    on(
      () => props.orch?.uiPrefsSignal()(),
      (payload) => {
        if (payload && payload.sortMode !== untrack(sortMode)) setSortMode(payload.sortMode)
        if (payload && payload.projectFilter !== untrack(projectFilter)) setProjectFilterSig(payload.projectFilter)
      },
    ),
  )

  // Update info comes from the daemon-owned `update` channel (the daemon polls
  // npm once and fans it out) rather than each pane hitting the registry. Keep
  // the last non-null value so a later null poll doesn't drop the chip.
  createEffect(() => {
    const info = props.orch?.updateSignal()()
    if (info) setUpdateInfo(info)
  })

  // Deps bag for every action in `tasks-pane/actions.ts` (file-size cap) —
  // built once per render, mirroring the settings-dialog/actions.ts
  // template. Thin wrappers below keep every JSX prop / keybinding call
  // site unchanged.
  const actionsCtx: TasksHostActionsContext = {
    tasks: () => props.tasks(),
    orch: props.orch,
    kv,
    dialog,
    notifyError,
    notifyInfo,
    reload: () => props.reload(),
    updateInfo,
    setSelectedId,
  }
  const switchRef: SwitchToRef = { token: 0 }
  const switchTo = (id: string): Promise<void> => switchToAction(actionsCtx, switchRef, id)

  // Shared task-action context (lib/task-actions): the flow bodies (confirm
  // copy, DIRTY_WORKTREE force-delete branch, error handling) live in that
  // shared module so this pane and the deprecated outer monitor can't drift
  // apart; `buildTaskActionsContext` supplies only what's genuinely this
  // host's (dialog wiring, toast surfacing, disk-only persistence, the
  // chattab create surface, and selection).
  const taskActions: CreateTaskContext = buildTaskActionsContext({
    ...actionsCtx,
    selectedId,
    setSelectedId,
    switchTo,
  })

  // `n` creates a new task using the SAME NewTaskDialog (and now the same
  // createTaskFlow) as the outer app — parity matters; this pane is meant
  // to replace the outer "page 1". The standalone pane has no Orchestrator,
  // so the flow fires the daemon's `task.create` RPC instead of calling it
  // in-process. Backlog task (worktree lazy on first enter).
  async function createTask(): Promise<void> {
    await createTaskFlow(taskActions)
  }

  async function archiveTask(id: string): Promise<void> {
    await archiveTaskFlow(taskActions, id)
  }

  async function deleteTask(id: string): Promise<void> {
    await deleteTaskFlow(taskActions, id)
  }

  // Rename a task's title via the daemon's `task.rename` RPC (same flow
  // the outer app's `r` uses). No pane zoom — the dialog shows
  // in place; the other panes stay visible.
  async function renameTask(id: string): Promise<void> {
    await renameTaskFlow(taskActions, id)
  }

  // Rename a task's branch via the `task.setBranch` RPC (`b`).
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

  // Collapsed state of the `── keys ──` legend (toggled by `?` / clicking
  // the header). A GLOBAL pref fanned out like sort/theme: seed from the
  // persisted value, apply locally for instant feedback, and persist via
  // kv so the daemon's ui-prefs watcher re-folds the legend in EVERY other
  // session's Tasks pane (the broadcast effect below). The kv write also
  // keeps the preference across pane respawns/upgrades.
  const [keysCollapsed, setKeysCollapsedSig] = createSignal<boolean>(kv.get("tasksPane.keysCollapsed", false) === true)
  const setKeysCollapsed = (next: boolean) => {
    setKeysCollapsedSig(next)
    kv.set("tasksPane.keysCollapsed", next)
  }
  // Follow the broadcast: a `?` toggle in another session re-folds this
  // legend too. Changed-only, so our own write's echo is a no-op.
  createEffect(
    on(
      () => props.orch?.uiPrefsSignal()(),
      (payload) => {
        if (payload && payload.keysCollapsed !== untrack(keysCollapsed)) setKeysCollapsedSig(payload.keysCollapsed)
      },
    ),
  )

  // The sidebar's `/`-search lifts its active state here so the host-level
  // plain-letter chords below go quiet while the user is TYPING a query —
  // without this gate, typing `n` into the search box would open the
  // new-task dialog (same class of leak as the dialog gate; the sidebar
  // de-registers its OWN letter chords during search but can't reach ours).
  const [searchActive, setSearchActive] = createSignal(false)

  // Gate on an empty dialog stack so a letter typed INTO a dialog field
  // doesn't re-fire the binding (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !searchActive(),
    // Chords come from KobeKeymap via bindByIds (f1=help.open, n=task.new,
    // s=settings.open.sidebar, w=worktrees.open.sidebar, u=tasks.update,
    // o/b/v=tasks.*) so user overrides from ~/.kobe/settings/keybindings.yaml
    // apply here too. F1 → the full-window help tab (openHelp), with the
    // shared HelpDialog as the no-session fallback. Gated on an empty
    // dialog stack so it doesn't `replace` an open dialog.
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
      "tasks.toggleKeys": () => setKeysCollapsed(!keysCollapsed()),
      // Fire-and-forget with an explicit catch — this pane process has no
      // crash net, so a rejection must not become an unhandled one.
      "tasks.focusEngine": () =>
        void focusEnginePane().catch((err) => console.error("[kobe tasks] focus engine pane failed:", err)),
    }),
  }))

  // Version / update chip for the Sidebar's brand header — moved up from the
  // footer's old `── system ──` block. Emphasised + clickable (opens the
  // update page) when an update is waiting, otherwise a quiet version label.
  const headerStatus = createMemo(() => {
    const info = updateInfo()
    if (info?.hasUpdate) return { label: `v${info.latest} ↑`, emphasize: true }
    return { label: `v${CURRENT_VERSION}`, emphasize: false }
  })

  // Daemon build-version skew (KOB). The daemon reports its build version on
  // the `hello` handshake; when it differs from THIS pane's CURRENT_VERSION the
  // user upgraded the binary but the long-lived daemon (and this pane) are still
  // running old code — Bun has no hot-reload, so it silently masks fixes. The
  // banner is non-fatal (the protocol is still compatible) and auto-hides once a
  // reconnect to a restarted daemon reports the matching version. Falls back to
  // not-stale when there's no daemon (file-poll fallback) — nothing to compare.
  const daemonStale = (): boolean => props.orch?.daemonStaleSignal()() ?? false
  const daemonVersion = (): string | null => props.orch?.daemonVersionSignal()() ?? null

  // Whether the cursor row is a `main` (project root) task. The branch (`B`)
  // and move (`M`) actions early-return on a main row, so the footer dims
  // those keycaps to signal "doesn't apply here" rather than letting the
  // press look like a silent no-op.
  const selectedIsMain = createMemo(() => props.tasks().find((t) => t.id === selectedId())?.kind === "main")

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <VersionSkewBanner
        stale={daemonStale}
        daemonVersion={daemonVersion}
        clientVersion={CURRENT_VERSION}
        width={() => dimensions().width}
      />
      <box flexGrow={1} flexShrink={1}>
        <Sidebar
          tasks={props.tasks}
          selectedId={selectedId}
          // A task-bound pane pins its highlight to its OWN task: picking
          // another row JUMPS to it (onActivate → switchTo) without repointing
          // this pane's persistent selection, which is what left a backgrounded
          // pane showing a sibling's row. The home pane selects normally.
          // Internal flows (create→selectTask, move, delete-reselect) still
          // drive setSelectedId directly, so they're unaffected.
          onSelect={props.initialTaskId ? () => {} : setSelectedId}
          // A task-bound pane pins its selection (onSelect no-ops): tell the
          // Sidebar so a jump-away click/Enter snaps the cursor back to the
          // pinned row instead of stranding it on the jumped-to project.
          pinnedSelection={!!props.initialTaskId}
          onActivate={(id) => void switchTo(id)}
          activateOnClick
          // Brand-header version/update chip (replaces the footer system block).
          headerStatus={headerStatus}
          onHeaderStatusClick={() => void openUpdate()}
          // Brand-header `+` new-task button — same flow as the `n` chord.
          onAddTask={() => void createTask()}
          // Bottom-left `☯ ZEN` badge while this ChatTab is collapsed to the
          // engine pane (polled from the window's `@kobe_zen_panes` option).
          zenActive={zenActive}
          // Clicking the `☯ ZEN` badge exits zen (mouse counterpart to the
          // prefix+space chord). Global toggle, so every project follows.
          onZenClick={() => {
            void (async () => {
              const session = await currentSessionName()
              if (session) await runLayoutAction(session, "zen-toggle")
            })()
          }}
          // Fill the whole tmux pane and follow live resizes (see `dimensions`
          // above). Without an explicit width the Sidebar pins to its 32-cell
          // rail default and leaves the rest of a widened pane blank.
          width={() => dimensions().width}
          // Event-driven engine activity (turn done / rate-limited / waiting
          // on approval), pushed from engine hooks via the daemon. Primary
          // liveness signal; the file-poll turn-detector stays as fallback.
          engineState={props.orch ? props.orch.engineStateSignal() : undefined}
          // Long daemon jobs (worktree materialisation) pushed on the
          // `task.jobs` channel — the row spins with "materializing" while
          // a minutes-long `git worktree add` runs, in every attached pane.
          taskJobs={props.orch ? props.orch.taskJobsSignal() : undefined}
          // Daemon-collected `+N −M` counts (issue #6): one `git status`
          // collector in the daemon, pushed on `worktree.changes`; this
          // pane spawns zero git processes while connected. Gated on the
          // LIVE connection (same pattern as the task-list source above):
          // a daemon idle-stop / restart flips this to null so the
          // Sidebar's local poller takes over instead of freezing on the
          // last pushed counts. The signal itself is null when the daemon
          // predates the channel (absent from hello.capabilities) — the
          // honest rolling-upgrade fallback.
          worktreeChanges={
            props.orch
              ? () => {
                  const orch = props.orch
                  if (!orch || orch.connectionStateSignal()() !== "online") return null
                  return orch.worktreeChangesSignal()()
                }
              : undefined
          }
          onRenameRequest={(id) => void renameTask(id)}
          onDeleteRequest={(id) => void deleteTask(id)}
          onArchiveRequest={(id) => void archiveTask(id)}
          onPinRequest={(id) => void togglePin(id)}
          onPreviewToggleRequest={(id) => void togglePreviewFlow(id)}
          onLocalMergeRequest={(id) => {
            const task = props.tasks().find((t) => t.id === id)
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
            const next: TaskSortMode = sortMode() === "default" ? "recent" : "default"
            // Apply locally for instant feedback, then persist — the kv write
            // lands in state.json and the daemon's ui-prefs watcher fans it
            // out to every other session's Tasks pane (KOB — global sort).
            setSortMode(next)
            kv.set("activeSortMode", next)
          }}
          // Gate the Sidebar's own bindings (Enter→switchTo, j/k, …) on an
          // empty dialog stack — otherwise Enter pressed to submit a dialog
          // (new-task / rename) leaks past the input to switchTo and yanks
          // you into a task (the Sidebar's Enter isn't registered through
          // the input's onSubmit, so the keymap falls through to it). Mirrors
          // the n/b/v gate above.
          focused={() => dialog.stack.length === 0}
          onSearchActiveChange={setSearchActive}
          // Track the cursor row so the host-scoped o/b/v chords act on the
          // highlighted task (like d/a/r), not on the active-task-following
          // `selectedId` (bug: o/b/v hit a different task than the cursor).
          onCursorChange={setCursorId}
        />
      </box>
      <ShortcutHints
        moveMode={moveMode}
        selectedIsMain={selectedIsMain}
        collapsed={keysCollapsed}
        onToggleCollapsed={() => setKeysCollapsed(!keysCollapsed())}
      />
    </box>
  )
}

export async function startTasksPane(opts: { initialTaskId?: string } = {}): Promise<void> {
  await bootPaneHost({
    logContext: "tasks",
    // Notifications power the bottom-right error toasts: under tmux's
    // alternate screen a failed action's `console.error` is invisible
    // (daemon log only), so a rejected key press surfaces as a red
    // chip here instead of looking like a silent no-op. The pane
    // only consumes the error toasts; per-ChatTab completion
    // notifications belong to the outer chat surface.
    providers: { notifications: true },
    setup: () => setupTasksPane(opts),
  })
}
