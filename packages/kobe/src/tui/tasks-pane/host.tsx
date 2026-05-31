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
 *   - Create: `n` (or the footer "+ New task") opens the SAME
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
  killSession,
  runTmux,
  sessionExists,
  tmuxSessionName,
} from "@/tmux/client"
import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { homeDir } from "../../env.ts"
import { DIRTY_WORKTREE_CODE } from "../../orchestrator/errors.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { resolveRepoInit } from "../../state/repo-init.ts"
import { addSavedRepo, getPersistedString, getSavedRepos, setPersistedString } from "../../state/repos.ts"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "../../types/task.ts"
import { nextVendor } from "../../types/vendor.ts"
import { CURRENT_VERSION, type UpdateInfo } from "../../version.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { FocusProvider } from "../context/focus"
import { KVProvider, useKV } from "../context/kv"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { DEFAULT_SETTINGS_SURFACE, SETTINGS_SURFACE_KEY, normalizeSettingsSurface } from "../lib/settings-surface"
import { detectWorktreeOpener, openWorktree } from "../lib/worktree-opener"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { ensureSession, openNewTaskTab, openSettingsTab, openUpdateTab } from "../panes/terminal/tmux.ts"
import { DialogProvider, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const FALLBACK_THEME = "claude"
const RELOAD_MS = 1500

function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
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
  const [selectedId, setSelectedId] = createSignal<string | null>(props.tasks()[0]?.id ?? null)
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)

  // Follow the SHARED active-task focus pushed on the daemon's `active-task`
  // channel: whichever task was last switched/entered into (from ANY session
  // or the outer monitor) is the one highlighted here, so every Tasks pane
  // shows the same focus instead of its own last click (KOB-247). Local
  // clicks still set selectedId optimistically; this keeps it consistent.
  createEffect(() => {
    const active = props.orch?.activeTaskSignal()()
    if (active) setSelectedId(active)
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

  // `n` (and the footer "+ New task" click) creates a new task using the
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
    const result = await NewTaskDialog.show(dialog, defaultRepo, repos, {
      defaultVendor,
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
    void SettingsDialog.show(dialog, kv, props.orch ?? undefined)
  }

  async function openUpdate(): Promise<void> {
    const info = updateInfo()
    if (!info?.hasUpdate) return
    const session = await currentSessionName()
    if (!session) return
    await openUpdateTab(session)
  }

  async function archiveTask(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    if (!task || !props.orch) return
    const nextArchived = !task.archived
    try {
      await props.orch.setArchived(id, nextArchived)
      if (nextArchived) {
        await killSession(tmuxSessionName(id)).catch((err: unknown) => {
          console.error("[kobe tasks] kill tmux session failed:", err)
        })
      }
    } catch (err) {
      console.error("[kobe tasks] archive failed:", err)
      return
    }
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
          }
        }
      } else {
        console.error("[kobe tasks] delete failed:", err)
      }
    }
    if (!deleted) return
    await killSession(tmuxSessionName(id)).catch((err: unknown) => {
      console.error("[kobe tasks] kill tmux session failed:", err)
    })
    await props.reload()
    if (selectedId() === id) {
      const remaining = props.tasks()
      setSelectedId((remaining.find((t) => !t.archived) ?? remaining[0])?.id ?? null)
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
    const next = await RenameTaskDialog.show(dialog, current.branch, { dialogTitle: "Rename branch" })
    if (!next || !props.orch) return
    try {
      await props.orch.setBranch(id, next)
    } catch (err) {
      console.error("[kobe tasks] task.setBranch failed:", err)
      return
    }
    await props.reload()
  }

  // Cycle the cursor task's engine vendor (claude ↔ codex ↔ …) via the
  // `task.setVendor` RPC. Takes effect on the task's next enter:
  // `ensureSession` rebuilds a session whose `@kobe_vendor` tag no longer
  // matches, so the new tmux pane launches the new engine.
  async function cycleVendor(id: string): Promise<void> {
    const current = props.tasks().find((t) => t.id === id)
    if (!current || !props.orch) return
    const next = nextVendor(current.vendor ?? DEFAULT_TASK_VENDOR)
    try {
      await props.orch.setVendor(id, next)
    } catch (err) {
      console.error("[kobe tasks] task.setVendor failed:", err)
      return
    }
    await props.reload()
  }

  async function openSelectedWorktree(id: string): Promise<void> {
    const task = props.tasks().find((t) => t.id === id)
    let worktree = task?.worktreePath
    if (!worktree || !existsSync(worktree)) {
      if (!props.orch) {
        console.error("[kobe tasks] no daemon; cannot materialise worktree")
        return
      }
      try {
        worktree = await props.orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        return
      }
      await props.reload()
    }
    if (!worktree || !existsSync(worktree)) return
    const opener = detectWorktreeOpener()
    if (!opener) {
      console.error("[kobe tasks] no editor/opener found; set KOBE_OPEN_EDITOR")
      return
    }
    if (!openWorktree(worktree, opener)) {
      console.error(`[kobe tasks] failed to open worktree with ${opener.label}`)
    }
  }

  // Gate on an empty dialog stack so a letter typed INTO a dialog field
  // doesn't re-fire the binding (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "n", cmd: () => void createTask() },
      { key: "s", cmd: () => void openSettings() },
      { key: "u", cmd: () => void openUpdate() },
      {
        key: "o",
        cmd: () => {
          const id = selectedId()
          if (id) void openSelectedWorktree(id)
        },
      },
      {
        key: "b",
        cmd: () => {
          const id = selectedId()
          if (id) void renameBranch(id)
        },
      },
      {
        key: "v",
        cmd: () => {
          const id = selectedId()
          if (id) void cycleVendor(id)
        },
      },
    ],
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
      if (cwd && existsSync(cwd)) {
        await ensureSession({
          name,
          cwd,
          command: interactiveEngineCommand(task?.vendor),
          taskId: id,
          vendor: task?.vendor,
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
    if (!cwd || !existsSync(cwd)) {
      if (!props.orch) {
        console.error("[kobe tasks] no daemon; cannot materialise worktree")
        return
      }
      try {
        cwd = await props.orch.ensureWorktree(id)
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        return
      }
      await props.reload()
    }
    if (!cwd || !existsSync(cwd)) return
    const init = task?.repo ? resolveRepoInit(task.repo, cwd) : {}
    const ready = await ensureSession({
      name,
      cwd,
      command: interactiveEngineCommand(task?.vendor),
      taskId: id,
      vendor: task?.vendor,
      initScript: init.initScript,
      initPrompt: init.initPrompt,
    })
    if (!ready) {
      console.error(`[kobe tasks] failed to start session ${name}`)
      return
    }
    await runTmux(["switch-client", "-t", `=${name}`])
    void props.orch?.setActiveTask(id).catch(() => {})
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <box flexGrow={1} flexShrink={1}>
        <Sidebar
          tasks={props.tasks}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onActivate={(id) => void switchTo(id)}
          activateOnClick
          onAddTask={() => void createTask()}
          onRenameRequest={(id) => void renameTask(id)}
          onDeleteRequest={(id) => void deleteTask(id)}
          onArchiveRequest={(id) => void archiveTask(id)}
          // Gate the Sidebar's own bindings (Enter→switchTo, j/k, …) on an
          // empty dialog stack — otherwise Enter pressed to submit a dialog
          // (new-task / rename) leaks past the input to switchTo and yanks
          // you into a task (the Sidebar's Enter isn't registered through
          // the input's onSubmit, so the keymap falls through to it). Mirrors
          // the n/b/v gate above (KOB-244).
          focused={() => dialog.stack.length === 0}
        />
      </box>
      <ShortcutHints updateInfo={updateInfo} onOpenUpdate={() => void openUpdate()} />
    </box>
  )
}

/**
 * A small shortcut legend pinned to the bottom of the Tasks pane (KOB-244):
 * shows the in-pane task actions plus the session-level tmux chords so the
 * keys are discoverable without leaving the pane. The `ctrl+h/j/k/l` and
 * `ctrl+[/]` lines are tmux session bindings — shown here, not rebound.
 */
function ShortcutHints(props: { updateInfo: Accessor<UpdateInfo | null>; onOpenUpdate: () => void }) {
  const { theme } = useTheme()
  const updateLabel = createMemo(() => {
    const info = props.updateInfo()
    if (!info) return `v${CURRENT_VERSION}`
    return info.hasUpdate ? `v${info.latest} available` : `v${CURRENT_VERSION} latest`
  })
  // Fixed-width key column so the labels line up — a terminal-grammar
  // legend column, not a proportional pane (allowed hardcode).
  // macOS-style key glyphs: ⌃ = control, ⏎ = return. Bare letters shown
  // uppercase per the Mac shortcut convention (the binding is still the
  // lowercase key — no shift implied).
  const HINTS: ReadonlyArray<{ k: string; label: string }> = [
    { k: "⏎", label: "open" },
    { k: "N", label: "new task" },
    { k: "S", label: "settings" },
    { k: "O", label: "open wt" },
    { k: "[/]", label: "views" },
    { k: "A/D", label: "archive/delete" },
    { k: "R/B/V", label: "name/branch/engine" },
    { k: "⌃HJKL", label: "move panes" },
    { k: "⌃[/]", label: "switch tabs" },
    { k: "⌃T", label: "new tab" },
    { k: "⌃⇧T", label: "engine tab" },
    { k: "Prefix T", label: "engine tab" },
    { k: "Prefix F", label: "new task" },
    { k: "F2", label: "rename tab" },
    { k: "⌃W", label: "close tab" },
    { k: "⌃Q", label: "detach" },
  ]
  return (
    <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={0}>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        ── system ──
      </text>
      <box flexDirection="row" gap={1}>
        <text
          fg={props.updateInfo()?.hasUpdate ? theme.warning : theme.textMuted}
          attributes={props.updateInfo()?.hasUpdate ? TextAttributes.BOLD : TextAttributes.DIM}
          wrapMode="none"
          onMouseUp={() => {
            if (props.updateInfo()?.hasUpdate) props.onOpenUpdate()
          }}
        >
          {updateLabel()}
        </text>
      </box>
      {/* When an update is published, surface the action — the self-update
          command — right here in the tmux-native footer, since the old
          outer-monitor update dialog isn't reachable on normal startup. */}
      <Show when={props.updateInfo()?.hasUpdate}>
        <box flexDirection="row" gap={1} onMouseUp={() => props.onOpenUpdate()}>
          <box width={10} flexShrink={0}>
            <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
              [U]
            </text>
          </box>
          <text fg={theme.accent} attributes={TextAttributes.DIM} wrapMode="none">
            update page
          </text>
        </box>
      </Show>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        ── keys ──
      </text>
      <For each={HINTS}>
        {(h) => (
          <box flexDirection="row" gap={1}>
            {/* `[key]` keycap chip — agent-deck style, mirrors the outer
                monitor's StatusBar Hotkey: bold accent key in brackets,
                muted label. No fill, so it stays clean in transparent
                mode. Fixed-width key column so the labels line up. */}
            <box width={10} flexShrink={0}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
                [{h.k}]
              </text>
            </box>
            <text fg={theme.textMuted} wrapMode="none">
              {h.label}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

export async function startTasksPane(): Promise<void> {
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
    const client = await connectOrStartDaemon()
    const remote = new RemoteOrchestrator(client)
    await remote.init() // hello + subscribe → tasksSignal() is now live
    orch = remote
  } catch (err) {
    console.error("[kobe tasks] daemon subscribe unavailable, polling tasks.json:", err)
  }

  const tasks: Accessor<readonly Task[]> = orch ? orch.tasksSignal() : fileTasks
  const reload = async (): Promise<void> => {
    // Subscribe keeps the list live; reload only matters in the polling
    // fallback (re-read the file after a local mutation).
    if (orch) return
    await store.load()
    setFileTasks(store.list())
  }
  const timer = orch ? undefined : setInterval(() => void reload(), RELOAD_MS)

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <KVProvider>
          <FocusProvider initial="sidebar">
            <DialogProvider>
              <TasksShell
                tasks={tasks}
                orch={orch}
                transparent={prefs.transparent}
                focusAccent={prefs.focusAccent}
                reload={reload}
              />
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
