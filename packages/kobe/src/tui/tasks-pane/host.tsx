/**
 * `kobe tasks` — the experimental Tasks pane on the far left of a
 * task's tmux session (KOB-233 experiment).
 *
 * agent-deck-style: keep the task list visible while you're inside a
 * tmux Session, so you can jump between tasks without detaching to the
 * outer monitor. Reuses the real `Sidebar`. Enter on a task
 * `tmux switch-client`s to that task's session.
 *
 * Scope of the experiment (deliberately minimal):
 *   - Reads `~/.kobe/tasks.json` directly and re-reads on a timer. The
 *     outer app's Orchestrator / Daemon still own most writes; this pane
 *     wires settings / delete / archive to the same daemon-backed paths
 *     as the outer monitor.
 *   - Rename: `r` renames the title (`task.rename` RPC); `b` renames the
 *     branch (`task.setBranch` RPC — `git branch -m` for a materialised
 *     worktree, else just recorded for the eventual ensureWorktree).
 *   - Engine: `v` cycles the task's vendor (`task.setVendor` RPC). Takes
 *     effect on next enter — ensureSession rebuilds the session when its
 *     `@kobe_vendor` tag no longer matches, launching the new engine.
 *   - Create: `n` opens the SAME
 *     NewTaskDialog as the outer app (repo picker + base branch + clone
 *     tab) and fires the daemon's `task.create` RPC — the first
 *     write-path here, the step toward retiring the outer "page 1".
 *     Default repo = cursor task's repo. Backlog task, worktree lazy.
 *   - Switch + lazy-create: Enter / click `switch-client`s to a task's
 *     session, creating it on demand (`ensureSession`) when the task's
 *     worktree already exists on disk — that covers every `main` task
 *     (worktree = repo root) and any worktree task entered at least
 *     once. A backlog task whose worktree was never materialised needs
 *     `git worktree add` from the Orchestrator (which this standalone
 *     pane doesn't have), so it stays a no-op; enter it from the outer
 *     monitor instead.
 */

import { existsSync } from "node:fs"
import { stat } from "node:fs/promises"
import { claudePaneIdStrict, currentSessionName, runTmux, runTmuxCapturing } from "@/tmux/client"
import { ZEN_HIDDEN_PANES_OPTION } from "@/tmux/session-layout"
import { t } from "@/tui/i18n"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import {
  type Accessor,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { homeDir } from "../../env.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { getCustomEngineIds, getPersistedString, setPersistedString } from "../../state/repos.ts"
import { TMUX_FOCUS_DEFAULTS, resolveUserTmuxKeys } from "../../tmux/keybindings.ts"
import type { Task } from "../../types/task.ts"
import { resolvePersistedVendor } from "../../types/vendor.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { HelpDialog } from "../component/help-dialog"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { ToastOverlay } from "../component/toast-overlay"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { bindByIds, findBinding, keymapVersion } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { formatChord, tmuxPrefixGlyph } from "../lib/chord-glyphs"
import { type HostScreen, bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "../lib/settings-surface"
import {
  type CreateTaskContext,
  archiveTaskFlow,
  createTaskFlow,
  cycleVendorFlow,
  deleteTaskFlow,
  renameBranchFlow,
  renameTaskFlow,
} from "../lib/task-actions"
import { HandoverError, enterTask } from "../lib/task-enter.ts"
import { truncateEnd } from "../lib/truncate"
import { detectWorktreeOpener, openWorktree } from "../lib/worktree-opener"
import { Sidebar } from "../panes/sidebar/Sidebar"
import type { TaskSortMode } from "../panes/sidebar/groups"
import { runLayoutAction } from "../panes/terminal/layout-actions.ts"
import {
  openHelpTab,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  refreshKobeWorkspacePanes,
} from "../panes/terminal/tmux.ts"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const RELOAD_MS = 1500

/**
 * Toast text for a failed `ensureWorktree`. The new-task dialog blocks
 * non-git repos pre-submit, but tasks created via other entry points (CLI,
 * adopted state) can still reach here with a bare `fatal: not a git
 * repository`. Translate that into the real reason — a task is a git
 * worktree + branch, so for now the project must already be a git repo
 * (non-git roots are a planned follow-up) — instead of leaking git's stderr.
 */
function worktreeErrorToast(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/not a git repository/i.test(raw)) {
    return t("tasks.toast.worktreeErrorNotGit")
  }
  return t("tasks.toast.worktreeErrorGeneric", { message: raw })
}

function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  initialTaskId?: string
  /**
   * The shared task-state framework: one daemon-backed RemoteOrchestrator
   * used for BOTH the live subscribe (reads) and every mutation (writes),
   * so the Tasks pane goes through the same single source of truth as the
   * outer monitor — no ad-hoc per-op clients (KOB-244). `null` only in the
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
  // Monotonic counter so a newer `switchTo` supersedes a slower in-flight one
  // (see switchTo). Plain mutable int — nothing reactive observes it.
  let switchToken = 0

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

  // Zen-mode indicator: poll THIS pane's window for `@kobe_zen_panes` (set by
  // the zen-toggle layout action while the ChatTab is collapsed to the engine
  // pane). The Sidebar renders a `☯ ZEN` badge bottom-left when active. A
  // 1s poll is cheap (one `show-options`, like the prefix probe) and there's
  // no daemon channel for tmux-local layout state. No-op for a standalone
  // `kobe tasks` with no `$TMUX_PANE`.
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

  // Shared active-task focus (the daemon's `active-task` channel, KOB-247) is
  // followed ONLY by a HOME pane (no initialTaskId) — the navigational surface
  // where selecting a row IS the focus, so it should mirror whatever was last
  // entered from any session.
  //
  // A pane SPAWNED for a task session (initialTaskId set) represents exactly
  // ONE task: its engine/chat is pinned to that task and never swaps. Following
  // shared focus made such a pane LIE — click a sibling project to jump to it
  // and this (now backgrounded) pane's highlight stuck on the sibling while its
  // chat still showed its own task. So a task-bound pane pins its highlight to
  // its own task and does NOT follow the channel; entering another task is a
  // jump (switchTo), not a re-selection of THIS pane. (Origin: KOB-247 scoped
  // shared focus to all panes; this narrows it back to the home pane.)
  createEffect(() => {
    if (props.initialTaskId) return
    const active = props.orch?.activeTaskSignal()()
    if (!active) return
    setSelectedId(active)
  })

  // Visual prefs (theme / transparent / focus accent) are applied
  // centrally — boot + live `ui-prefs` pushes — by host-boot's
  // UiPrefsSync; this shell no longer re-applies them itself. Sort mode,
  // project filter, and the keys-legend fold ride the SAME `ui-prefs`
  // channel but are pane-state, not theme-state, so the Tasks pane follows
  // them here: a `t` / `ctrl+p` / `?` toggle in ANY session lands as a push
  // and re-applies to this pane too. Changed-only assignment makes the echo
  // of our own write (round-tripped through the watcher) a no-op. (Sort +
  // project filter here; the keys-legend effect lives next to its signal
  // further down.)
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

  // Shared task-action context (lib/task-actions). The flow bodies —
  // confirm copy, DIRTY_WORKTREE force-delete branch, error handling —
  // live in the shared module so this pane and the deprecated outer
  // monitor can't drift apart. What stays here is only what's genuinely
  // this host's: dialog wiring, toast surfacing, disk-only persistence,
  // the chattab create surface, and selection.
  const taskActions: CreateTaskContext = {
    orch: props.orch,
    tasks: () => props.tasks(),
    confirm: async (p) => (await DialogConfirm.show(dialog, p.title, p.body, p.cancelLabel, p.confirmLabel)) === true,
    // Dialogs show IN the Tasks pane without zooming it full-window
    // (KOB-244): the old `resize-pane -Z` hid the claude / ops / shell
    // panes for the dialog's lifetime, which felt like the whole layout
    // "popped out". The dialog overlay already caps to the pane width
    // (`maxWidth = dimensions().width - 2`), so it renders fine in the
    // ~22%-wide pane — just narrower — and the other panes stay visible.
    promptText: (initial, opts) => RenameTaskDialog.show(dialog, initial, opts),
    logger: console,
    logPrefix: "[kobe tasks]",
    notifyError,
    notifyInfo,
    reload: () => props.reload(),
    // This pane runs INSIDE the tmux client whose session a delete kills —
    // switch away first so the kill doesn't yank the user's terminal.
    switchBeforeKill: true,
    // Publish the shared active-task focus so every surface follows (KOB-247).
    updateActiveTask: true,
    onTaskDeleted: (taskId, nextTask) => {
      if (selectedId() !== taskId) return
      const remaining = props.tasks()
      setSelectedId(nextTask?.id ?? (remaining.find((t) => !t.archived) ?? remaining[0])?.id ?? null)
    },
    promptNewTask: (defaultRepo, repos, opts) => NewTaskDialog.show(dialog, defaultRepo, repos, opts),
    // "Spawn a sibling" default: the cursor task's repo (fallback: the
    // first listed task's).
    cursorRepo: () => {
      const list = props.tasks()
      return (list.find((t) => t.id === selectedId()) ?? list[0])?.repo
    },
    // This pane uses disk-only persistence (no in-process kv store), so the
    // atomic disk write is sufficient — no onRepoSaved kv mirror needed.
    lastVendor: () => resolvePersistedVendor(getPersistedString("lastSelectedVendor"), getCustomEngineIds()),
    rememberVendor: (vendor) => setPersistedString("lastSelectedVendor", vendor),
    // Same surface preference as Settings (default chattab): open the
    // new-task flow as a dedicated full-window page in a new tmux tab.
    // The page performs the create/adopt itself and the subscribe pushes
    // the new task back into this list. Fall back to the in-pane overlay
    // if we can't resolve our tmux session.
    openCreateSurface: async (defaultRepo) => {
      const surface = normalizeSettingsSurface(kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
      if (surface !== "chattab") return false
      const session = await currentSessionName()
      if (!session) return false
      await openNewTaskTab(session, defaultRepo)
      return true
    },
    // Land the cursor on the new task so Enter / click enters it next.
    // (The daemon subscribe pushes the new task into the list momentarily.)
    selectTask: (id) => setSelectedId(id),
    // Then enter it: `n` drops the user straight into the new task's engine
    // pane (the same enter loop Enter/click runs), ready to type the first
    // prompt — not just a moved cursor.
    enterTask: (id) => switchTo(id),
  }

  // `n` creates a new task using the SAME NewTaskDialog (and now the same
  // createTaskFlow) as the outer app — parity matters; this pane is meant
  // to replace the outer "page 1". The standalone pane has no Orchestrator,
  // so the flow fires the daemon's `task.create` RPC instead of calling it
  // in-process. Backlog task (worktree lazy on first enter).
  async function createTask(): Promise<void> {
    await createTaskFlow(taskActions)
  }

  // Settings opens on the user's chosen surface (default chattab): a
  // dedicated full-window `kobe settings` page opened as a new tmux tab,
  // or the in-pane SettingsDialog overlay. If we can't resolve our tmux
  // session (e.g. running outside a kobe pane), fall back to the overlay.
  async function openSettings(): Promise<void> {
    const surface = normalizeSettingsSurface(kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
    if (surface === "chattab") {
      const session = await currentSessionName()
      if (session) {
        await openSettingsTab(session)
        return
      }
    }
    const result = await SettingsDialog.show(dialog, kv, props.orch ?? undefined)
    if (!result.visualPrefsChanged) return
    if (!kv.flush()) return
    try {
      const session = await currentSessionName()
      if (session) await refreshKobeWorkspacePanes(session)
    } catch (err) {
      console.error("[kobe tasks] failed to refresh workspace panes:", err)
    }
  }

  // F1 help opens as a dedicated full-window tab (like Settings) — the
  // in-pane HelpDialog overlay only had the narrow Tasks rail to render
  // in, which truncated every keybinding row. Fall back to the overlay
  // when we can't resolve our tmux session (e.g. running outside a kobe
  // pane).
  async function openHelp(): Promise<void> {
    const session = await currentSessionName()
    if (session) {
      await openHelpTab(session)
      return
    }
    HelpDialog.show(dialog)
  }

  async function openUpdate(): Promise<void> {
    const info = updateInfo()
    if (!info?.hasUpdate) {
      // The `u` chord / update chip would otherwise no-op silently when
      // nothing is pending — confirm the up-to-date state instead (#23a).
      notifyInfo(t("tasks.toast.alreadyLatest", { version: CURRENT_VERSION }))
      return
    }
    const session = await currentSessionName()
    if (!session) return
    await openUpdateTab(session)
  }

  async function archiveTask(id: string): Promise<void> {
    await archiveTaskFlow(taskActions, id)
  }

  async function deleteTask(id: string): Promise<void> {
    await deleteTaskFlow(taskActions, id)
  }

  // Rename a task's title via the daemon's `task.rename` RPC (same flow
  // the outer app's `r` uses). No pane zoom (KOB-244) — the dialog shows
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

  async function openSelectedWorktree(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    let worktree = task?.worktreePath
    if (!worktree || !existsSync(worktree)) {
      if (!props.orch) {
        console.error("[kobe tasks] no daemon; cannot materialise worktree")
        notifyError(t("tasks.toast.noDaemonWorktree"))
        return
      }
      try {
        worktree = await props.orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        notifyError(worktreeErrorToast(err))
        return
      }
      await props.reload()
    }
    if (!worktree || !existsSync(worktree)) return
    const opener = detectWorktreeOpener()
    if (!opener) {
      console.error("[kobe tasks] no editor/opener found; set KOBE_OPEN_EDITOR")
      notifyError(t("tasks.toast.noEditor"))
      return
    }
    if (!openWorktree(worktree, opener)) {
      console.error(`[kobe tasks] failed to open worktree with ${opener.label}`)
      notifyError(t("tasks.toast.openWorktreeFailed", { label: opener.label }))
    }
  }

  // Right arrow → re-focus THIS window's engine (claude/codex) pane, the
  // inverse of ctrl+h. Targeting: the role-tagged lookup
  // (`claudePaneIdStrict` → `@kobe_role=claude`, vendor-neutral) is the
  // honest "current window's engine pane" — `paneIdByRole` lists the
  // session's ACTIVE window, which is necessarily the window holding this
  // pane (we only receive the keystroke while active), so no window
  // derivation from $TMUX_PANE is needed. Preferred over
  // `select-pane -t $TMUX_PANE -R`, which grabs whatever pane happens to
  // sit right of the rail (wrong after a manual rearrange) — same shape as
  // selectTasksPane, the ctrl+q first stage, just pointed the other way.
  // No-op outside tmux (standalone `kobe tasks` has no $TMUX_PANE) or when
  // the window has no tagged engine pane (legacy session).
  async function focusEnginePane(): Promise<void> {
    if (!process.env.TMUX_PANE) return
    const session = await currentSessionName()
    if (!session) return
    const pane = await claudePaneIdStrict(session)
    if (!pane) return
    await runTmux(["select-pane", "-t", pane])
  }

  async function moveTask(id: string, delta: -1 | 1): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    if (!task || task.kind === "main" || !props.orch) return
    try {
      await props.orch.moveTask(id, delta)
    } catch (err) {
      console.error("[kobe tasks] task.move failed:", err)
      notifyError(t("tasks.toast.moveTaskFailed", { message: err instanceof Error ? err.message : String(err) }))
      return
    }
    setSelectedId(id)
    await props.reload()
  }

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
    // s=settings.open.sidebar, u=tasks.update, o/b/v=tasks.*) so user
    // overrides from ~/.kobe/settings/keybindings.yaml apply here too.
    // F1 → the full-window help tab (openHelp), with the shared HelpDialog
    // as the no-session fallback. Gated on an empty dialog stack so it
    // doesn't `replace` an open dialog.
    bindings: bindByIds({
      "help.open": () => void openHelp(),
      "task.new": () => void createTask(),
      "settings.open.sidebar": () => void openSettings(),
      "tasks.update": () => void openUpdate(),
      "tasks.openWorktree": () => {
        const id = selectedId()
        if (id) void openSelectedWorktree(id)
      },
      "tasks.renameBranch": () => {
        const id = selectedId()
        if (id) void renameBranch(id)
      },
      "tasks.cycleEngine": () => {
        const id = selectedId()
        if (id) void cycleVendor(id)
      },
      "tasks.toggleKeys": () => setKeysCollapsed(!keysCollapsed()),
      // Fire-and-forget with an explicit catch — this pane process has no
      // crash net, so a rejection must not become an unhandled one.
      "tasks.focusEngine": () =>
        void focusEnginePane().catch((err) => console.error("[kobe tasks] focus engine pane failed:", err)),
    }),
  }))

  // Enter / click on a task → switch this tmux client to that task's
  // session, creating it on demand. The full enter loop:
  //   1. session running → just switch-client.
  //   2. session gone but worktree on disk → ensureSession + switch.
  //   3. backlog task, no worktree yet → materialise it via the daemon's
  //      `task.ensureWorktree` RPC (git worktree add — only the
  //      Orchestrator can do it), then ensureSession + switch.
  // Step 3 closes the create→enter loop entirely inside the Tasks pane
  // (a task you just made with `n` is enterable here, no detour through
  // the outer monitor).
  async function switchTo(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    if (!task) return
    // Monotonic switch token: a newer switchTo supersedes any still-in-flight
    // one. enterTask checks `isCurrent` before its disruptive setActive +
    // switch-client, so a slow cold-session switch that finishes after a later
    // click can't drag the active task (and thus the home pane's selection)
    // back to the superseded project. (Fixes the "click A → click B → top-left
    // selection sticks on A" race.)
    const myToken = ++switchToken
    // The whole enter sequence (capture from-layout → ensure/heal session →
    // zen → setActive → fit + switch) lives in the Handover owner; the Tasks
    // pane opts into capture + heal and reloads its mirror after a cold
    // worktree materialise. `includeInitPrompt: true` keeps prior switchTo
    // behaviour (always weave the marker-guarded repo-init). enterTask throws a
    // HandoverError on a build failure; we map its phase to the right toast.
    try {
      await enterTask(props.orch, task, task.repo, task.vendor, {
        includeInitPrompt: true,
        heal: true,
        captureFrom: true,
        reload: () => props.reload(),
        isCurrent: () => switchToken === myToken,
      })
    } catch (err) {
      if (err instanceof HandoverError) {
        if (err.phase === "no-daemon") notifyError(t("tasks.toast.noDaemonOpen"))
        else if (err.phase === "worktree") notifyError(worktreeErrorToast(err.cause ?? err))
        else notifyError(t("tasks.toast.sessionStartFailed"))
      } else {
        console.error("[kobe tasks] switchTo failed:", err)
      }
    }
  }

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
          // the n/b/v gate above (KOB-244).
          focused={() => dialog.stack.length === 0}
          onSearchActiveChange={setSearchActive}
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

/**
 * Resolve a single binding id to the chord cap the footer should advertise:
 * the cosmetic `hint.keys` when present (it's refreshed in place on an
 * override — keymap-overrides.ts), else the canonical first chord. Returns
 * `null` when the id is unbound (no chords) — the row that owns it should
 * then drop, since advertising a dead chord is worse than none (mirrors the
 * override path that nulls a hint on unbind).
 *
 * Pure + exported so the legend derivation is unit-testable against a faked
 * keymap without booting a tmux pane (the host itself isn't CI-runnable).
 */
export function legendCap(id: string): string | null {
  const row = findBinding(id)
  if (!row) return null
  const cap = row.hint?.keys ?? row.keys[0]
  return cap && cap.length > 0 ? cap : null
}

/**
 * Resolve a (possibly composite) legend row's keycap from the binding ids it
 * represents. Each id contributes its {@link legendCap}; unbound ids drop out
 * and the survivors join with `/` (so `r/b/v` becomes `r/v` if `b` is
 * unbound, or the whole row drops when nothing survives). Returns `null` when
 * every id resolved to no chord — the caller drops the row entirely.
 */
export function legendRowCap(ids: readonly string[]): string | null {
  const caps = ids.map(legendCap).filter((c): c is string => c !== null)
  return caps.length > 0 ? caps.join("/") : null
}

/**
 * A small shortcut legend pinned to the bottom of the Tasks pane (KOB-244):
 * shows the in-pane task actions plus the session-level tmux chords so the
 * keys are discoverable without leaving the pane. The `ctrl+h/j/k/l` and
 * `ctrl+[/]` lines are tmux session bindings — shown here, not rebound.
 *
 * Collapsible: the legend is ~20 rows with the tmux chords included, which
 * crowds the task list on short terminals. `?` (or clicking the header)
 * folds it down to the header line; move-mode hints ignore the fold — a
 * user inside reorder mode must always see how to leave it.
 */
function ShortcutHints(props: {
  moveMode?: Accessor<boolean>
  selectedIsMain?: Accessor<boolean>
  collapsed?: Accessor<boolean>
  onToggleCollapsed?: () => void
}) {
  const { theme } = useTheme()
  // Resolve the user's REAL tmux prefix at runtime (#12). kobe loads the
  // user's own prefix, so a literal `Prefix F` is un-actionable — the user may
  // not know their prefix is C-a. Shell `tmux show-options -g prefix` on the
  // -L kobe socket (runTmuxCapturing already targets it) and render `C-b` as
  // `⌃B`. Falls back to the literal `Prefix` when resolution fails / is flaky.
  const [prefixCap, setPrefixCap] = createSignal("Prefix")
  onMount(() => {
    void runTmuxCapturing(["show-options", "-g", "prefix"]).then(({ code, stdout }) => {
      if (code !== 0) return
      const glyph = tmuxPrefixGlyph(stdout)
      if (glyph) setPrefixCap(glyph)
    })
  })
  // A hint row. `k` is a MACHINE chord string (`ctrl+q`, `prefix f`, `a/d`);
  // it's rendered as macOS glyphs via `formatChord` at draw time, so the
  // footer, the F1 help, and the status bar all read the same (one formatter,
  // no drift). `dimWhenMain` flags a keycap whose action early-returns on a
  // `main` (project root) row — the footer dims that cap so a press there reads
  // as "doesn't apply here" rather than a silent no-op (Issue #7).
  type Hint = { k: string; label: string; dimWhenMain?: boolean }
  // tmux session-key rows derive from the RESOLVED key set so user
  // overrides (`tmux.*` ids in ~/.kobe/settings/keybindings.yaml) show
  // their own chords here; an unbound id drops its row. Pseudo-chords
  // ("ctrl+hjkl", "ctrl+[/]") are kept only while the relevant keys are
  // still at their defaults — overridden keys render as plain chords.
  const tmuxHints = (): ReadonlyArray<Hint> => {
    // Re-derive after a live keybindings reload: the bump invalidates this
    // accessor so the footer re-renders with the freshly-resolved tmux
    // chords (the resolver's cache is cleared in the same reload).
    keymapVersion()
    const res = resolveUserTmuxKeys()
    const b = res.binds
    const out: Hint[] = []
    const focusChords = res.focus.filter((f): f is NonNullable<typeof f> => f !== null).map((f) => f.chord)
    if (focusChords.length === 4 && focusChords.every((c, i) => c === TMUX_FOCUS_DEFAULTS[i])) {
      out.push({ k: "ctrl+hjkl", label: t("tasks.hints.movePanes") })
    } else if (focusChords.length > 0) {
      out.push({ k: focusChords[0] as string, label: t("tasks.hints.movePanes") })
    }
    const layoutGroup = (label: string, ids: readonly (keyof typeof b)[]): void => {
      const chords = ids.map((id) => b[id]?.chord).filter((chord): chord is string => !!chord)
      if (chords.length > 0) out.push({ k: `prefix ${chords.join("/")}`, label })
    }
    // Trimmed legend: keep pane movement, the tasks→detach chord, and the two
    // tmux-prefix layout groups. Per-tab rows (switch / new / engine / rename /
    // close) live in F1 full help, not the footer.
    if (b["tmux.detach"]) out.push({ k: b["tmux.detach"].chord, label: t("tasks.hints.detach") })
    layoutGroup(t("tasks.hints.splits"), [
      "tmux.layout.workspaceSplit",
      "tmux.layout.workspaceClose",
      "tmux.layout.workspaceReset",
    ])
    layoutGroup(t("tasks.hints.panes"), [
      "tmux.layout.tasksToggle",
      "tmux.layout.opsToggle",
      "tmux.layout.terminalToggle",
    ])
    return out
  }
  // Fixed-width key column so labels line up — a terminal-grammar legend
  // column, not a proportional pane (allowed hardcode). formatChord keeps
  // plain-letter caps lowercase (the EXACT key to press, #14), uppercases the
  // key of modifier chords (`⌃ Q`), shows `tab` as a word, and renders the two
  // `prefix …` rows with the user's REAL resolved prefix (`prefixCap()`, #12).
  // Derived (not a static const) so those rows re-render once the async prefix
  // resolution lands.
  // Each in-pane row's keycap is DERIVED from KobeKeymap (legendRowCap) so a
  // user override / unbind in ~/.kobe/settings/keybindings.yaml is reflected
  // here — the footer is the only always-visible legend, and the doc promises
  // it follows the keymap (docs/KEYBINDINGS.md). The ids mirror a curated
  // subset of the pane's bindings plus the Sidebar-owned sidebar.* rows it
  // delegates to (Enter→sidebar.select, [/]→sidebar.view, d→sidebar.delete).
  // `keymapVersion()` is read at the top so a live reload re-renders the
  // legend with the freshly-resolved chords — same pattern as tmuxHints().
  // Each row is conditional: an id that resolved to no chord (unbound) drops
  // its row rather than advertising a dead key.
  const defaultHints = (): ReadonlyArray<Hint> => {
    keymapVersion()
    // Trimmed legend (KOB request): the footer carries only the high-traffic
    // rows; everything else (sort, move/merge, archive, rename/branch/engine,
    // per-tab tmux chords) is reachable via F1 full help. Order here is the
    // exact order the rows render in.
    const rows: Array<{ ids: readonly string[]; label: string; dimWhenMain?: boolean }> = [
      { ids: ["help.open"], label: t("tasks.hints.fullHelp") },
      { ids: ["task.new"], label: t("tasks.hints.newTask") },
      { ids: ["settings.open.sidebar"], label: t("tasks.hints.settings") },
      { ids: ["sidebar.select"], label: t("tasks.hints.open") },
      // Right arrow re-focuses the current window's engine pane
      // (tasks.focusEngine) — renders as [→] via formatChord's KEY_GLYPH.
      { ids: ["tasks.focusEngine"], label: t("tasks.hints.focusEngine") },
      { ids: ["tasks.openWorktree"], label: t("tasks.hints.openWorktree") },
      { ids: ["sidebar.delete"], label: t("tasks.hints.delete") },
      { ids: ["sidebar.view"], label: t("tasks.hints.views") },
      { ids: ["sidebar.projectFilter"], label: t("tasks.hints.project") },
    ]
    const out: Hint[] = []
    for (const row of rows) {
      const k = legendRowCap(row.ids)
      if (k === null) continue
      out.push({ k, label: row.label, dimWhenMain: row.dimWhenMain })
    }
    out.push(...tmuxHints())
    return out
  }
  const MOVE_HINTS = (): ReadonlyArray<Hint> => [
    { k: "j/k", label: t("tasks.hints.reorder") },
    { k: "enter/esc", label: t("tasks.hints.done") },
  ]
  const hints = () => (props.moveMode?.() ? MOVE_HINTS() : defaultHints())
  // Width of the description column = the longest label, but CAPPED so a long
  // label can't blow the column out past what the 32-cell Tasks pane (minus the
  // 10-cell keycap column) can hold. Each row right-aligns this fixed-width box
  // (text left-aligned inside), so every description shares one left edge AND
  // the whole column hugs the pane's right side. Labels longer than the cap are
  // ellipsised rather than allowed to overflow.
  const LABEL_COL_MAX = 18
  const labelColWidth = () => Math.min(LABEL_COL_MAX, Math.max(...hints().map((h) => h.label.length)))
  const clipLabel = (s: string): string => truncateEnd(s, labelColWidth())
  // Version + update moved UP to the Sidebar's `kobe` brand header (the old
  // `── system ──` block lived here); the footer is now just the key legend.
  // Move-mode overrides the fold: its two hints are the only exit
  // instructions for reorder mode, so they always render.
  const folded = () => (props.collapsed?.() ?? false) && !(props.moveMode?.() ?? false)
  return (
    <box
      flexShrink={0}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={0}
    >
      {/* Header doubles as the toggle: `?` chord or a click folds/unfolds.
          The `?▸ / ?▾` tail advertises both the chord and the state. */}
      <text
        fg={theme.textMuted}
        attributes={TextAttributes.DIM}
        wrapMode="none"
        onMouseUp={() => props.onToggleCollapsed?.()}
      >
        {folded() ? t("tasks.hints.headerFolded") : t("tasks.hints.headerUnfolded")}
      </text>
      <Show when={!folded()}>
        <For each={hints()}>
          {(h) => {
            // Dim a cap whose action early-returns on a `main` row (`B`/`M`):
            // muted + DIM instead of bold accent, so the user sees it doesn't
            // apply to the project row rather than pressing it into silence.
            const dim = () => h.dimWhenMain === true && (props.selectedIsMain?.() ?? false)
            return (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                {/* `[key]` keycap chip — agent-deck style, mirrors the outer
                monitor's StatusBar Hotkey: bold accent key in brackets,
                muted label. No fill, so it stays clean in transparent mode. */}
                <box width={10} flexShrink={0}>
                  <text
                    fg={dim() ? theme.textMuted : theme.accent}
                    attributes={dim() ? TextAttributes.DIM : TextAttributes.BOLD}
                    wrapMode="none"
                  >
                    [{formatChord(h.k, prefixCap())}]
                  </text>
                </box>
                {/* Description column — fixed width = longest label, pushed to the
                right edge by space-between. Text is left-aligned inside, so
                every description shares one left edge while the whole column
                hugs the right side and rides the pane width. */}
                <box width={labelColWidth()} flexShrink={0}>
                  <text fg={theme.textMuted} attributes={dim() ? TextAttributes.DIM : undefined} wrapMode="none">
                    {clipLabel(h.label)}
                  </text>
                </box>
              </box>
            )
          }}
        </For>
      </Show>
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

async function setupTasksPane(opts: { initialTaskId?: string }): Promise<HostScreen> {
  // Task source. PRIMARY = a live daemon SUBSCRIBE (via RemoteOrchestrator):
  // a task created / renamed / deleted in ANY session's Tasks pane or in
  // the outer monitor is pushed to THIS pane in real time, so every
  // session's list stays in sync (KOB-244 — a new task wasn't showing up
  // in an already-open session's Tasks pane). The shared env baked onto
  // this pane's command (inheritedEnvPrefix) guarantees we connect to the
  // SAME daemon as everyone else.
  //
  // FALLBACK = a direct tasks.json read + slow poll, used only when the
  // daemon is unreachable. MUST pass `homeDir()` (KOBE_HOME_DIR-aware) or
  // it would read the PRODUCTION `~/.kobe/tasks.json` (KOB-233).
  const store = new TaskIndexStore({ homeDir: homeDir() })
  await store.load()
  const [fileTasks, setFileTasks] = createSignal<readonly Task[]>(store.list())

  let orch: RemoteOrchestrator | null = null
  try {
    // NON-spawning connect. A Tasks pane subscribes as role:"pane" and must
    // NEVER start a daemon — doing so would resurrect an idle-stopped daemon
    // with no gui to hold it, breaking the refcounted lazy-shutdown. This bit
    // most visibly via `kobe reload`, which respawns this pane while the user
    // may be detached (daemon already idle-stopped): a spawning connect would
    // leave a gui-less daemon running forever. A gui owns daemon lifecycle; if
    // none is up we fall through to the always-on tasks.json poll below.
    const client = await connectIfRunning()
    if (client) {
      const remote = new RemoteOrchestrator(client)
      await remote.init() // hello + subscribe → tasksSignal() is now live
      orch = remote
    } else {
      logClient("tasks-boot", "no daemon running — polling tasks.json (a gui owns daemon lifecycle)")
    }
  } catch (err) {
    logClientError("tasks-boot", err)
    logClient("tasks-boot", "daemon subscribe failed — polling tasks.json")
  }

  // Display source: prefer the daemon's live snapshot WHILE the socket is
  // online, otherwise fall back to the file poll. A plain-function accessor
  // (not createMemo) so it isn't a computation created outside a render root;
  // it reactively tracks whichever signals it reads on each call. The crucial
  // fix for the create/delete sync drift: when the daemon idle-stops / restarts
  // and the socket closes, `connectionStateSignal()` flips to "disconnected"
  // and the display switches to the always-running file poll instead of
  // FREEZING on the last daemon snapshot (the old `orch ? orch.tasksSignal()`
  // had no fallback once subscribed). The orchestrator's own non-spawning
  // reconnect loop then restores the live path when a daemon returns.
  const tasks: Accessor<readonly Task[]> = () =>
    orch && orch.connectionStateSignal()() === "online" ? orch.tasksSignal()() : fileTasks()
  const reload = async (): Promise<void> => {
    await store.load()
    setFileTasks(store.list())
  }
  // ALWAYS run the backstop poll (not gated on daemon availability, unlike
  // before — that gate was the freeze bug). It does the file read only when
  // the daemon push path is NOT the live source, so an online pane pays
  // nothing and an offline one stays fresh within RELOAD_MS.
  //
  // Offline ticks are additionally mtime-gated (waste audit): tasks.json
  // only changes on a mutation, so a cheap `stat` decides whether the full
  // read+parse is needed — an idle offline pane pays one stat per 1.5s
  // instead of re-reading and re-parsing the whole index 40×/min. Writes
  // are atomic temp+rename, so mtime+size always move on a real change.
  // A stat failure maps to a distinct "missing" fingerprint: deletion →
  // recreation each reload exactly once. Explicit `reload()` calls (after
  // mutations) bypass the gate on purpose. Errors are swallowed — this
  // pane process has no crash net (see ops/host.tsx), so a transient fs
  // error must degrade to a stale list, not an unhandled rejection.
  let lastTasksFileFingerprint = ""
  const timer = setInterval(() => {
    if (orch && orch.connectionStateSignal()() === "online") return
    void (async () => {
      let fingerprint = "missing"
      try {
        const st = await stat(store.filePath)
        fingerprint = `${st.mtimeMs}:${st.size}`
      } catch {
        // keep the "missing" fingerprint
      }
      if (fingerprint === lastTasksFileFingerprint) return
      lastTasksFileFingerprint = fingerprint
      await reload()
    })().catch(() => {})
  }, RELOAD_MS)

  return {
    root: () => (
      <>
        <TasksShell tasks={tasks} initialTaskId={opts.initialTaskId} orch={orch} reload={reload} />
        <ToastOverlay />
      </>
    ),
    // Tear down on ACTUAL exit, not after render() resolves: `render`
    // resolves at mount (cf. startApp, which also cleans up via
    // onDestroy), so disposing here is the only correct place. Disposing
    // after `await render(...)` killed the daemon client + poll the moment
    // the pane mounted → "daemon client disposed" on the next switch and
    // a dead subscribe (KOB-247).
    onDestroy: () => {
      if (timer) clearInterval(timer)
      orch?.dispose()
    },
  }
}
