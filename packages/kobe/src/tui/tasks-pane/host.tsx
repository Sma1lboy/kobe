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
 *     leaves delete/archive/pin as no-ops.
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
import { getSessionOption, runTmux, sessionExists, tmuxSessionName } from "@/tmux/client"
import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { type Accessor, For, createSignal, onCleanup, onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { homeDir } from "../../env.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { getPersistedString, getSavedRepos, setPersistedString } from "../../state/repos.ts"
import { DEFAULT_TASK_VENDOR, type Task, type VendorId } from "../../types/task.ts"
import { nextVendor } from "../../types/vendor.ts"
import { NewTaskDialog } from "../component/new-task-dialog"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { FocusProvider } from "../context/focus"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { ensureSession } from "../panes/terminal/tmux.ts"
import { DialogProvider, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"

const FALLBACK_THEME = "claude"
const RELOAD_MS = 1500

function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  transparent: boolean
  focusAccent: ReturnType<typeof readPersistedUiPrefs>["focusAccent"]
  /** Force an immediate tasks.json re-read after a mutation. */
  reload: () => Promise<void>
}) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const [selectedId, setSelectedId] = createSignal<string | null>(props.tasks()[0]?.id ?? null)

  onMount(() => {
    themeCtx.setTransparentBackground(props.transparent)
    if (props.focusAccent) themeCtx.setFocusAccent(props.focusAccent)
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
    // Show the dialog IN the Tasks pane without zooming it full-window
    // (KOB-244): the old `resize-pane -Z` hid the claude / ops / shell
    // panes for the dialog's lifetime, which felt like the whole layout
    // "popped out". The dialog overlay already caps to the pane width
    // (`maxWidth = dimensions().width - 2`), so it renders fine in the
    // ~22%-wide pane — just narrower — and the other panes stay visible.
    const repos = getSavedRepos()
    if (repos.length === 0) {
      await DialogConfirm.show(
        dialog,
        "No saved repos.",
        "Run `kobe add <path>` from a shell first to register a repo, then come back here.",
        "",
        "ok",
      )
      return
    }
    const list = props.tasks()
    const cursorRepo = (list.find((t) => t.id === selectedId()) ?? list[0])?.repo
    const defaultRepo = cursorRepo ?? repos[0] ?? ""
    const defaultVendor = (getPersistedString("lastSelectedVendor") as VendorId | undefined) ?? DEFAULT_TASK_VENDOR
    const result = await NewTaskDialog.show(dialog, defaultRepo, repos, { defaultVendor })
    if (!result) return
    // Remember the choice (shared kv state.json) so the next new-task
    // dialog — here or in the outer monitor — defaults to it.
    setPersistedString("lastSelectedVendor", result.vendor)
    let createdId: string | undefined
    try {
      const client = await connectOrStartDaemon()
      try {
        const res = await client.request<{ taskId: string }>("task.create", {
          repo: result.repo,
          baseRef: result.baseRef,
          vendor: result.vendor,
        })
        createdId = res.taskId
      } finally {
        client.close()
      }
    } catch (err) {
      console.error("[kobe tasks] task.create failed:", err)
      return
    }
    await props.reload()
    // Land the cursor on the new task so Enter / click enters it next.
    if (createdId) setSelectedId(createdId)
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
    if (!next) return
    try {
      const client = await connectOrStartDaemon()
      try {
        await client.request("task.rename", { taskId: id, title: next })
      } finally {
        client.close()
      }
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
    if (!next) return
    try {
      const client = await connectOrStartDaemon()
      try {
        await client.request("task.setBranch", { taskId: id, branch: next })
      } finally {
        client.close()
      }
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
    if (!current) return
    const next = nextVendor(current.vendor ?? DEFAULT_TASK_VENDOR)
    try {
      const client = await connectOrStartDaemon()
      try {
        await client.request("task.setVendor", { taskId: id, vendor: next })
      } finally {
        client.close()
      }
    } catch (err) {
      console.error("[kobe tasks] task.setVendor failed:", err)
      return
    }
    await props.reload()
  }

  // Gate on an empty dialog stack so a letter typed INTO a dialog field
  // doesn't re-fire the binding (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "n", cmd: () => void createTask() },
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
      return
    }

    // No session yet. Resolve the worktree — for a never-entered backlog
    // task, materialise it via the daemon's task.ensureWorktree RPC (git
    // worktree add — only the Orchestrator can do it) — then build the
    // session and switch.
    let cwd = task?.worktreePath
    if (!cwd || !existsSync(cwd)) {
      try {
        const client = await connectOrStartDaemon()
        try {
          const res = await client.request<{ worktreePath: string }>("task.ensureWorktree", { taskId: id })
          cwd = res.worktreePath
        } finally {
          client.close()
        }
      } catch (err) {
        console.error("[kobe tasks] task.ensureWorktree failed:", err)
        return
      }
      await props.reload()
    }
    if (!cwd || !existsSync(cwd)) return
    const ready = await ensureSession({
      name,
      cwd,
      command: interactiveEngineCommand(task?.vendor),
      taskId: id,
      vendor: task?.vendor,
    })
    if (!ready) {
      console.error(`[kobe tasks] failed to start session ${name}`)
      return
    }
    await runTmux(["switch-client", "-t", `=${name}`])
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
          // Gate the Sidebar's own bindings (Enter→switchTo, j/k, …) on an
          // empty dialog stack — otherwise Enter pressed to submit a dialog
          // (new-task / rename) leaks past the input to switchTo and yanks
          // you into a task (the Sidebar's Enter isn't registered through
          // the input's onSubmit, so the keymap falls through to it). Mirrors
          // the n/b/v gate above (KOB-244).
          focused={() => dialog.stack.length === 0}
        />
      </box>
      <ShortcutHints />
    </box>
  )
}

/**
 * A small shortcut legend pinned to the bottom of the Tasks pane (KOB-244):
 * shows the in-pane task actions plus the session-level tmux chords so the
 * keys are discoverable without leaving the pane. The `ctrl+h/j/k/l` line is
 * the existing tmux pane navigation — shown here, not rebound.
 */
function ShortcutHints() {
  const { theme } = useTheme()
  // Fixed-width key column so the labels line up — a terminal-grammar
  // legend column, not a proportional pane (allowed hardcode).
  // macOS-style key glyphs: ⌃ = control, ⏎ = return. Bare letters shown
  // uppercase per the Mac shortcut convention (the binding is still the
  // lowercase key — no shift implied).
  const HINTS: ReadonlyArray<{ k: string; label: string }> = [
    { k: "⏎", label: "open" },
    { k: "N", label: "new task" },
    { k: "R/B/V", label: "name / branch / engine" },
    { k: "⌃HJKL", label: "move panes" },
    { k: "⌃T", label: "new tab" },
    { k: "⌃Q", label: "monitor" },
  ]
  return (
    <box flexShrink={0} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={0}>
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

  // Read-only task source: load the manifest now, re-read on a timer so
  // tasks created/renamed in the outer app show up here too. MUST pass
  // `homeDir()` (KOBE_HOME_DIR-aware) — TaskIndexStore's bare default is
  // `os.homedir()`, which would read the PRODUCTION `~/.kobe/tasks.json`
  // even inside a sandbox session, so the Tasks pane would show a
  // different task list than the outer monitor it's meant to mirror
  // (KOB-233).
  const store = new TaskIndexStore({ homeDir: homeDir() })
  await store.load()
  const [tasks, setTasks] = createSignal<readonly Task[]>(store.list())
  const reload = async (): Promise<void> => {
    await store.load()
    setTasks(store.list())
  }
  const timer = setInterval(() => {
    void reload()
  }, RELOAD_MS)

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <FocusProvider initial="sidebar">
          <DialogProvider>
            <TasksShell tasks={tasks} transparent={prefs.transparent} focusAccent={prefs.focusAccent} reload={reload} />
          </DialogProvider>
        </FocusProvider>
      </ThemeProvider>
    ),
    {
      backgroundColor: "transparent",
      externalOutputMode: "passthrough",
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
      useKittyKeyboard: {},
    },
  )
  clearInterval(timer)
}
