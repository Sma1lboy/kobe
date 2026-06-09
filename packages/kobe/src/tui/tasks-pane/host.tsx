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
import {
  currentSessionName,
  getSessionOption,
  runTmux,
  runTmuxCapturing,
  sessionExists,
  tmuxSessionName,
} from "@/tmux/client"
import { TextAttributes } from "@opentui/core"
import { render, useTerminalDimensions } from "@opentui/solid"
import { logClient, logClientError, setClientLogContext } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { availableEngineIds } from "../../engine/account-detect.ts"
import { engineDisplayName, interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { homeDir } from "../../env.ts"
import { execHostForWorktreePath } from "../../exec/resolve.ts"
import { DIRTY_WORKTREE_CODE } from "../../orchestrator/errors.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { resolveRepoInit } from "../../state/repo-init.ts"
import {
  addSavedRepo,
  getPersistedString,
  getSavedRepos,
  isRemoteRepoKey,
  setPersistedString,
} from "../../state/repos.ts"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "../../types/task.ts"
import { nextVendorWithin } from "../../types/vendor.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { HelpDialog } from "../component/help-dialog"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { ToastOverlay } from "../component/toast-overlay"
import { VersionSkewBanner } from "../component/version-skew-banner"
import { FocusProvider } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { applyUserKeybindings } from "../context/keybindings-user"
import { KVProvider, useKV } from "../context/kv"
import { NotificationsProvider, useNotifications } from "../context/notifications"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { formatChord, tmuxPrefixGlyph } from "../lib/chord-glyphs"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "../lib/settings-surface"
import { finishDeletedTaskFlow, toggleTaskArchivedFlow } from "../lib/task-actions"
import { detectWorktreeOpener, openWorktree } from "../lib/worktree-opener"
import { Sidebar } from "../panes/sidebar/Sidebar"
import type { TaskSortMode } from "../panes/sidebar/groups"
import {
  ensureSession,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  refreshKobeWorkspacePanes,
} from "../panes/terminal/tmux.ts"
import { DialogProvider, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const FALLBACK_THEME = "claude"
const RELOAD_MS = 1500

/**
 * Whether a worktree path is usable as a session cwd. A REMOTE worktree lives
 * on another host, so a local `existsSync` would (wrongly) say "missing" and
 * block opening the task — for a remote path we trust it exists remotely (the
 * orchestrator created it over SSH). Local paths keep the real on-disk check.
 */
function worktreeCwdUsable(cwd: string | undefined): cwd is string {
  if (!cwd) return false
  return execHostForWorktreePath(cwd).isRemote || existsSync(cwd)
}

function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  initialTaskId?: string
  transparent: boolean
  focusAccent: ReturnType<typeof readPersistedUiPrefs>["focusAccent"]
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
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()
  const notif = useNotifications()
  const [selectedId, setSelectedId] = createSignal<string | null>(
    props.tasks().some((t) => t.id === props.initialTaskId) ? props.initialTaskId! : (props.tasks()[0]?.id ?? null),
  )

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
  const [sortMode, setSortMode] = createSignal<TaskSortMode>("default")
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  // The Tasks pane OWNS its whole tmux pane (unlike the outer monitor, where the
  // Sidebar is a fixed-width rail beside the workspace). So the embedded Sidebar
  // must FILL the pane, not sit at its default 32-cell rail width — otherwise
  // dragging the tmux split wider just leaves dead space to the right. opentui's
  // renderer tracks the pane size (SIGWINCH → onResize), so feeding the live
  // terminal width to the Sidebar's width accessor makes it reflow to 100% of the
  // pane on every resize.
  const dimensions = useTerminalDimensions()

  // Follow the SHARED active-task focus pushed on the daemon's `active-task`
  // channel: whichever task was last switched/entered into (from ANY session
  // or the outer monitor) is the one highlighted here, so every Tasks pane
  // shows the same focus instead of its own last click (KOB-247). Local
  // clicks still set selectedId optimistically; this keeps it consistent.
  //
  // One guard: a pane SPAWNED for a task session (initialTaskId set) is the
  // pane for THAT task — its own session's task is the authority for the
  // initial highlight. But `switchTo` publishes setActiveTask(id) only AFTER
  // `switch-client`, so when this freshly-built pane first subscribes the
  // daemon replays the PRE-switch active-task value. Applying it would clobber
  // our correct initialTaskId selection back to the previously-entered row
  // (often the top one) for a frame, until our own setActiveTask lands. So we
  // ignore replayed values until the channel CONFIRMS our own task, then
  // resume following shared focus normally. Home panes (no initialTaskId)
  // never enter the guard and behave exactly as before.
  let activeConfirmed = !props.initialTaskId
  createEffect(() => {
    const active = props.orch?.activeTaskSignal()()
    if (!active) return
    if (!activeConfirmed) {
      if (active !== props.initialTaskId) return
      activeConfirmed = true
    }
    setSelectedId(active)
  })

  onMount(() => {
    themeCtx.setTransparentBackground(props.transparent)
    if (props.focusAccent) themeCtx.setFocusAccent(props.focusAccent)
  })

  // Update info comes from the daemon-owned `update` channel (the daemon polls
  // npm once and fans it out) rather than each pane hitting the registry. Keep
  // the last non-null value so a later null poll doesn't drop the chip.
  createEffect(() => {
    const info = props.orch?.updateSignal()()
    if (info) setUpdateInfo(info)
  })

  // `n` creates a new task using the
  // SAME NewTaskDialog the outer app uses (repo picker + base-branch +
  // clone tab) — parity matters; this pane is meant to replace the outer
  // "page 1". The standalone pane has no Orchestrator, so it fires the
  // daemon's `task.create` RPC instead of calling it in-process. Default
  // repo is the cursor task's repo (fallback: first saved repo), matching
  // the outer app's "spawn a sibling" default. Backlog task (worktree
  // lazy on first enter); list reloads immediately after.
  async function createTask(): Promise<void> {
    const repos = getSavedRepos()
    const list = props.tasks()
    const cursorRepo = (list.find((t) => t.id === selectedId()) ?? list[0])?.repo
    // First run (no saved repos): default the dialog to the cwd so the
    // user picks a path in-TUI instead of being sent to a shell for
    // `kobe add` (saved mode preselects it; typing `/` flips to the
    // directory browser). Otherwise default to the cursor task's repo
    // (the "spawn a sibling" default).
    const defaultRepo = cursorRepo ?? repos[0] ?? process.cwd()

    // Same surface preference as Settings (default chattab): open the
    // new-task flow as a dedicated full-window page in a new tmux tab.
    // The page performs the create/adopt itself and the subscribe pushes
    // the new task back into this list. Fall back to the in-pane overlay
    // if we can't resolve our tmux session.
    const surface = normalizeSettingsSurface(kv.get(SETTINGS_SURFACE_KEY, DEFAULT_SETTINGS_SURFACE))
    if (surface === "chattab") {
      const session = await currentSessionName()
      if (session) {
        await openNewTaskTab(session, defaultRepo)
        return
      }
    }

    // Show the dialog IN the Tasks pane without zooming it full-window
    // (KOB-244): the old `resize-pane -Z` hid the claude / ops / shell
    // panes for the dialog's lifetime, which felt like the whole layout
    // "popped out". The dialog overlay already caps to the pane width
    // (`maxWidth = dimensions().width - 2`), so it renders fine in the
    // ~22%-wide pane — just narrower — and the other panes stay visible.
    const defaultVendor = (getPersistedString("lastSelectedVendor") as VendorId | undefined) ?? DEFAULT_TASK_VENDOR
    const availableVendors = await availableEngineIds()
    // First-run guard (#24): no built-in engine detected AND no custom engine
    // configured. The dialog would still let the user pick a vendor, then the
    // missing binary surfaces only as a raw shell error inside the pane. Warn
    // up front but still allow proceeding (they may install it after picking).
    if (availableVendors.length === 0) {
      notifyInfo("No engine CLI detected — install claude or codex, or add one in Settings → Engines")
    }
    const result = await NewTaskDialog.show(dialog, defaultRepo, repos, {
      defaultVendor,
      availableVendors,
      discoverAdoptable: props.orch ? (repo) => props.orch!.discoverAdoptableWorktrees(repo) : undefined,
    })
    if (!result) return
    // Remember the choice (shared kv state.json) so the next new-task
    // dialog — here or in the outer monitor — defaults to it.
    setPersistedString("lastSelectedVendor", result.vendor)
    // Auto-save the chosen repo so the saved list self-populates and
    // `kobe add` stays optional. This pane uses disk-only persistence
    // (no in-process kv store), so the atomic disk write is sufficient.
    addSavedRepo(result.repo)
    if (!props.orch) {
      console.error("[kobe tasks] no daemon; cannot create task")
      return
    }
    // The create/adopt awaits a real git-worktree operation with no other
    // feedback — the dialog just vanishes. Surface a transient "working" toast
    // so the wait reads as progress; failure replaces it with the error toast
    // raised in the catch below.
    notifyInfo("Creating task…")
    let createdId: string | undefined
    try {
      if (result.mode === "adopt") {
        for (const w of result.adopt) {
          const t = await props.orch.adoptWorktree({
            repo: result.repo,
            worktreePath: w.worktreePath,
            branch: w.branch,
            vendor: result.vendor,
          })
          createdId = t.id
        }
      } else {
        const task = await props.orch.createTask({
          repo: result.repo,
          baseRef: result.baseRef,
          vendor: result.vendor,
        })
        createdId = task.id
      }
    } catch (err) {
      console.error("[kobe tasks] task.create/adopt failed:", err)
      notifyError(`Couldn't create task: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await props.reload()
    // Land the cursor on the new task so Enter / click enters it next.
    // (The daemon subscribe pushes the new task into the list momentarily.)
    if (createdId) setSelectedId(createdId)
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

  async function openUpdate(): Promise<void> {
    const info = updateInfo()
    if (!info?.hasUpdate) {
      // The `u` chord / update chip would otherwise no-op silently when
      // nothing is pending — confirm the up-to-date state instead (#23a).
      notifyInfo(`Already on the latest version (v${CURRENT_VERSION})`)
      return
    }
    const session = await currentSessionName()
    if (!session) return
    await openUpdateTab(session)
  }

  async function archiveTask(id: string): Promise<void> {
    if (!props.orch) return
    const task = props.tasks().find((t) => t.id === id)
    if (!task) return
    // Unarchive is harmless (brings the task back) — no confirm. Archiving
    // STOPS the task's running engine session, so confirm first.
    if (!task.archived) {
      const ok = await DialogConfirm.show(
        dialog,
        `Archive "${task.title}"?`,
        "Moves it to Archives and stops its running session. The worktree, branch, and chat history stay — unarchive to bring it back.",
        "cancel",
        "archive",
      )
      if (ok !== true) return
    }
    const result = await toggleTaskArchivedFlow({
      orch: props.orch,
      tasks: props.tasks(),
      taskId: id,
      logger: console,
      logPrefix: "[kobe tasks]",
      updateActiveTask: true,
    })
    if (!result) return
    await props.reload()
  }

  async function deleteTask(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    if (!task || !props.orch) return
    const ok = await DialogConfirm.show(
      dialog,
      `Delete "${task.title}"?`,
      "Removes the task entry and its worktree. The tmux session (if any) is killed.",
      "cancel",
      "delete",
    )
    if (ok !== true) return
    let deleted = false
    try {
      await props.orch.deleteTask(id)
      deleted = true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(DIRTY_WORKTREE_CODE)) {
        const forceOk = await DialogConfirm.show(
          dialog,
          `"${task.title}" has uncommitted changes`,
          "Its worktree has uncommitted or untracked work that will be permanently deleted. Force delete anyway?",
          "cancel",
          "force delete",
        )
        if (forceOk === true) {
          try {
            await props.orch.deleteTask(id, { force: true })
            deleted = true
          } catch (forceErr) {
            console.error("[kobe tasks] force delete failed:", forceErr)
            notifyError(`Couldn't delete: ${forceErr instanceof Error ? forceErr.message : String(forceErr)}`)
          }
        }
      } else {
        console.error("[kobe tasks] delete failed:", err)
        notifyError(`Couldn't delete: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (!deleted) return
    const { nextTask } = await finishDeletedTaskFlow({
      orch: props.orch,
      tasks: props.tasks(),
      taskId: id,
      logger: console,
      logPrefix: "[kobe tasks]",
      switchBeforeKill: true,
      updateActiveTask: true,
    })
    await props.reload()
    if (selectedId() === id) {
      const remaining = props.tasks()
      setSelectedId(nextTask?.id ?? (remaining.find((t) => !t.archived) ?? remaining[0])?.id ?? null)
    }
  }

  // Rename a task's title via the daemon's `task.rename` RPC (same path
  // the outer app's `r` uses). No pane zoom (KOB-244) — the dialog shows
  // in place; the other panes stay visible. The branch follows the title
  // for not-yet-materialised tasks (autoBranch derives from it); a
  // worktree that already exists keeps its git branch.
  async function renameTask(id: string): Promise<void> {
    const current = props.tasks().find((t) => t.id === id)
    if (!current) return
    const next = await RenameTaskDialog.show(dialog, current.title)
    if (!next || !props.orch) return
    try {
      await props.orch.setTitle(id, next)
    } catch (err) {
      console.error("[kobe tasks] task.rename failed:", err)
      notifyError(`Couldn't rename task: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await props.reload()
  }

  // Rename a task's branch via `task.setBranch` RPC. For a materialised
  // worktree the daemon runs `git branch -m` (HEAD moves on the
  // checked-out worktree, a running session keeps streaming); otherwise
  // it just records the name for the eventual `ensureWorktree`.
  async function renameBranch(id: string): Promise<void> {
    const current = props.tasks().find((t) => t.id === id)
    if (!current || current.kind === "main") return
    const next = await RenameTaskDialog.show(dialog, current.branch, {
      dialogTitle: "Rename branch",
      fieldLabel: "branch",
    })
    if (!next || !props.orch) return
    try {
      await props.orch.setBranch(id, next)
    } catch (err) {
      console.error("[kobe tasks] task.setBranch failed:", err)
      notifyError(`Couldn't rename branch: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    await props.reload()
  }

  // Cycle the cursor task's engine vendor (claude ↔ codex ↔ …) via the
  // `task.setVendor` RPC. Takes effect on the task's next enter:
  // `ensureSession` rebuilds a session whose `@kobe_vendor` tag no longer
  // matches, so the new tmux pane launches the new engine.
  //
  // Cycle over the SAME detected-built-ins + custom set the new-task dialog
  // offers (`availableEngineIds()` + `nextVendorWithin`), not the 3 built-ins
  // alone: a task on a user-added custom engine must be able to cycle back to
  // it instead of jumping to a built-in and getting stranded (`nextVendor`
  // only walked `ALL_VENDORS`).
  async function cycleVendor(id: string): Promise<void> {
    const current = props.tasks().find((t) => t.id === id)
    if (!current || !props.orch) return
    const engines = await availableEngineIds()
    const next = nextVendorWithin(engines, current.vendor ?? DEFAULT_TASK_VENDOR)
    try {
      await props.orch.setVendor(id, next)
    } catch (err) {
      console.error("[kobe tasks] task.setVendor failed:", err)
      notifyError(`Couldn't switch engine: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // The new vendor only takes effect on the task's NEXT enter (ensureSession
    // rebuilds the pane when its `@kobe_vendor` tag no longer matches), so a
    // bare `v` press looks like a no-op. Surface the deferred-rebuild contract.
    notifyInfo(`Engine → ${engineDisplayName(next)} (applies on reopen)`)
    await props.reload()
  }

  async function openSelectedWorktree(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    let worktree = task?.worktreePath
    if (!worktree || !existsSync(worktree)) {
      if (!props.orch) {
        console.error("[kobe tasks] no daemon; cannot materialise worktree")
        notifyError("No daemon running — can't create the worktree")
        return
      }
      try {
        worktree = await props.orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        notifyError(`Couldn't create worktree: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      await props.reload()
    }
    if (!worktree || !existsSync(worktree)) return
    const opener = detectWorktreeOpener()
    if (!opener) {
      console.error("[kobe tasks] no editor/opener found; set KOBE_OPEN_EDITOR")
      notifyError("No editor found — set KOBE_OPEN_EDITOR (e.g. 'code', 'cursor', 'nvim')")
      return
    }
    if (!openWorktree(worktree, opener)) {
      console.error(`[kobe tasks] failed to open worktree with ${opener.label}`)
      notifyError(`Couldn't open worktree with ${opener.label}`)
    }
  }

  async function moveTask(id: string, delta: -1 | 1): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    if (!task || task.kind === "main" || !props.orch) return
    try {
      await props.orch.moveTask(id, delta)
    } catch (err) {
      console.error("[kobe tasks] task.move failed:", err)
      notifyError(`Couldn't move task: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setSelectedId(id)
    await props.reload()
  }

  // Gate on an empty dialog stack so a letter typed INTO a dialog field
  // doesn't re-fire the binding (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    // Chords come from KobeKeymap via bindByIds (f1=help.open, n=task.new,
    // s=settings.open.sidebar, u=tasks.update, o/b/v=tasks.*) so user
    // overrides from ~/.kobe/settings/keybindings.yaml apply here too.
    // F1 → the shared HelpDialog (#8). In the real direct-tmux flow the
    // global `help.open` (app.tsx outer monitor) never runs, so F1 was dead
    // in the Tasks pane. The pane has its own DialogProvider (mounted in
    // startTasksPane), so we open it the same way app.tsx does. Gated on an
    // empty dialog stack so it doesn't `replace` an open dialog.
    bindings: bindByIds({
      "help.open": () => HelpDialog.show(dialog),
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
    const name = tmuxSessionName(id)
    const task = props.tasks().find((t) => t.id === id)
    const exists = await sessionExists(name)

    // A LIVE session ALWAYS gets switched into — clicking a running task
    // must jump, full stop. Its worktree dir comes from the session's own
    // `@kobe_worktree` tag, NOT the Tasks-pane tasks.json read (which can
    // lag the daemon and show an empty worktreePath; relying on it made a
    // click bail before switch-client — KOB-244 regression). We still run
    // ensureSession to heal vendor/worktree drift, but never let that
    // block the switch.
    if (exists) {
      const cwd = (await getSessionOption(name, "@kobe_worktree")) || task?.worktreePath || ""
      if (worktreeCwdUsable(cwd)) {
        await ensureSession({
          name,
          cwd,
          command: interactiveEngineCommand(task?.vendor),
          taskId: id,
          vendor: task?.vendor,
          remoteKey: task?.repo && isRemoteRepoKey(task.repo) ? task.repo : undefined,
        })
      }
      await runTmux(["switch-client", "-t", `=${name}`])
      void props.orch?.setActiveTask(id).catch(() => {})
      return
    }

    // No session yet. Resolve the worktree — for a never-entered backlog
    // task, materialise it via the daemon's task.ensureWorktree RPC (git
    // worktree add — only the Orchestrator can do it) — then build the
    // session and switch.
    let cwd = task?.worktreePath
    if (!worktreeCwdUsable(cwd)) {
      if (!props.orch) {
        console.error("[kobe tasks] no daemon; cannot materialise worktree")
        notifyError("No daemon running — can't open this task")
        return
      }
      try {
        cwd = await props.orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        notifyError(`Couldn't create worktree: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      await props.reload()
    }
    if (!worktreeCwdUsable(cwd)) return
    const init = task?.repo ? resolveRepoInit(task.repo, cwd) : {}
    const ready = await ensureSession({
      name,
      cwd,
      command: interactiveEngineCommand(task?.vendor),
      taskId: id,
      vendor: task?.vendor,
      remoteKey: task?.repo && isRemoteRepoKey(task.repo) ? task.repo : undefined,
      initScript: init.initScript,
      initPrompt: init.initPrompt,
    })
    if (!ready) {
      console.error(`[kobe tasks] failed to start session ${name}`)
      notifyError("Couldn't start this task's session")
      return
    }
    await runTmux(["switch-client", "-t", `=${name}`])
    void props.orch?.setActiveTask(id).catch(() => {})
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
          onSelect={setSelectedId}
          onActivate={(id) => void switchTo(id)}
          activateOnClick
          // Brand-header version/update chip (replaces the footer system block).
          headerStatus={headerStatus}
          onHeaderStatusClick={() => void openUpdate()}
          // Brand-header `+` new-task button — same flow as the `n` chord.
          onAddTask={() => void createTask()}
          // Fill the whole tmux pane and follow live resizes (see `dimensions`
          // above). Without an explicit width the Sidebar pins to its 32-cell
          // rail default and leaves the rest of a widened pane blank.
          width={() => dimensions().width}
          // Event-driven engine activity (turn done / rate-limited / waiting
          // on approval), pushed from engine hooks via the daemon. Primary
          // liveness signal; the file-poll turn-detector stays as fallback.
          engineState={props.orch ? props.orch.engineStateSignal() : undefined}
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
          onSortModeToggle={() => setSortMode((cur) => (cur === "default" ? "recent" : "default"))}
          // Gate the Sidebar's own bindings (Enter→switchTo, j/k, …) on an
          // empty dialog stack — otherwise Enter pressed to submit a dialog
          // (new-task / rename) leaks past the input to switchTo and yanks
          // you into a task (the Sidebar's Enter isn't registered through
          // the input's onSubmit, so the keymap falls through to it). Mirrors
          // the n/b/v gate above (KOB-244).
          focused={() => dialog.stack.length === 0}
        />
      </box>
      <ShortcutHints moveMode={moveMode} selectedIsMain={selectedIsMain} />
    </box>
  )
}

/**
 * A small shortcut legend pinned to the bottom of the Tasks pane (KOB-244):
 * shows the in-pane task actions plus the session-level tmux chords so the
 * keys are discoverable without leaving the pane. The `ctrl+h/j/k/l` and
 * `ctrl+[/]` lines are tmux session bindings — shown here, not rebound.
 */
function ShortcutHints(props: { moveMode?: Accessor<boolean>; selectedIsMain?: Accessor<boolean> }) {
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
  // Fixed-width key column so labels line up — a terminal-grammar legend
  // column, not a proportional pane (allowed hardcode). formatChord keeps
  // plain-letter caps lowercase (the EXACT key to press, #14), uppercases the
  // key of modifier chords (`⌃ Q`), shows `tab` as a word, and renders the two
  // `prefix …` rows with the user's REAL resolved prefix (`prefixCap()`, #12).
  // Derived (not a static const) so those rows re-render once the async prefix
  // resolution lands.
  const defaultHints = (): ReadonlyArray<Hint> => [
    { k: "enter", label: "open" },
    { k: "n", label: "new task" },
    { k: "s", label: "settings" },
    { k: "o", label: "open wt" },
    { k: "[/]", label: "views" },
    { k: "t", label: "sort" },
    // Move (`M`) is Shift+M and early-returns on a main row — dim it there.
    { k: "M", label: "move task", dimWhenMain: true },
    // `a` is a TOGGLE — archive AND unarchive — so the label says both.
    { k: "a/d", label: "un/archive·delete" },
    // Rename title (`r`) and cycle engine (`v`) work on a main row; only
    // rename branch (`b`) early-returns there, so the row dims as a whole
    // on main to signal the branch action is unavailable.
    { k: "r/b/v", label: "name/branch/engine", dimWhenMain: true },
    { k: "f1", label: "help" },
    { k: "ctrl+hjkl", label: "move panes" },
    { k: "ctrl+[/]", label: "switch tabs" },
    { k: "ctrl+t", label: "new tab" },
    { k: "ctrl+shift+t", label: "engine tab" },
    { k: "prefix t", label: "engine tab" },
    { k: "prefix f", label: "new task" },
    { k: "f2", label: "rename tab" },
    { k: "ctrl+w", label: "close tab" },
    { k: "ctrl+q", label: "tasks→detach" },
  ]
  const MOVE_HINTS: ReadonlyArray<Hint> = [
    { k: "j/k", label: "reorder" },
    { k: "enter/esc", label: "done" },
  ]
  const hints = () => (props.moveMode?.() ? MOVE_HINTS : defaultHints())
  // Width of the description column = the longest label, but CAPPED so a long
  // label can't blow the column out past what the 32-cell Tasks pane (minus the
  // 10-cell keycap column) can hold. Each row right-aligns this fixed-width box
  // (text left-aligned inside), so every description shares one left edge AND
  // the whole column hugs the pane's right side. Labels longer than the cap are
  // ellipsised rather than allowed to overflow.
  const LABEL_COL_MAX = 18
  const labelColWidth = () => Math.min(LABEL_COL_MAX, Math.max(...hints().map((h) => h.label.length)))
  const clipLabel = (s: string): string =>
    s.length <= labelColWidth() ? s : `${s.slice(0, Math.max(0, labelColWidth() - 1))}…`
  // Version + update moved UP to the Sidebar's `kobe` brand header (the old
  // `── system ──` block lived here); the footer is now just the key legend.
  return (
    <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={0}>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        ── keys ──
      </text>
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
    </box>
  )
}

export async function startTasksPane(opts: { initialTaskId?: string } = {}): Promise<void> {
  setClientLogContext("tasks")
  applyUserKeybindings()
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const prefs = readPersistedUiPrefs(FALLBACK_THEME)

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
  const timer = setInterval(() => {
    if (orch && orch.connectionStateSignal()() === "online") return
    void reload()
  }, RELOAD_MS)

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <KVProvider>
          <FocusProvider initial="sidebar">
            <DialogProvider>
              {/* Notifications power the bottom-right error toasts: under tmux's
                  alternate screen a failed action's `console.error` is invisible
                  (daemon log only), so a rejected key press surfaces as a red
                  chip here instead of looking like a silent no-op. The pane
                  only consumes the error toasts; per-ChatTab completion
                  notifications belong to the outer chat surface. */}
              <NotificationsProvider>
                <TasksShell
                  tasks={tasks}
                  initialTaskId={opts.initialTaskId}
                  orch={orch}
                  transparent={prefs.transparent}
                  focusAccent={prefs.focusAccent}
                  reload={reload}
                />
                <ToastOverlay />
              </NotificationsProvider>
            </DialogProvider>
          </FocusProvider>
        </KVProvider>
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
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
    },
  )
}
