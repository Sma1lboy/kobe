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
 *   - Rename: `r` opens the RenameTaskDialog and fires the daemon's
 *     `task.rename` RPC. Branch follows the title for not-yet-built
 *     tasks; a materialised worktree keeps its git branch.
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
import { runTmux, sessionExists, tmuxSessionName } from "@/tmux/client"
import { render } from "@opentui/solid"
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js"
import { connectOrStartDaemon } from "../../client/daemon-process.ts"
import { homeDir } from "../../env.ts"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import { getSavedRepos } from "../../state/repos.ts"
import type { Task } from "../../types/task.ts"
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
    // Zoom the Tasks pane to the full window for the dialog's lifetime.
    // The pane is only ~22% wide, which would clip the medium (80-col)
    // NewTaskDialog and make it look different from the outer monitor's
    // full-width version (KOB-233). `resize-pane -Z` toggles zoom; the
    // pane is never zoomed in normal use, so on→off is symmetric.
    const selfPane = process.env.TMUX_PANE
    if (selfPane) await runTmux(["resize-pane", "-Z", "-t", selfPane])
    try {
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
      const result = await NewTaskDialog.show(dialog, defaultRepo, repos)
      if (!result) return
      let createdId: string | undefined
      try {
        const client = await connectOrStartDaemon()
        try {
          const res = await client.request<{ taskId: string }>("task.create", {
            repo: result.repo,
            baseRef: result.baseRef,
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
    } finally {
      if (selfPane) await runTmux(["resize-pane", "-Z", "-t", selfPane])
    }
  }

  // Rename a task's title via the daemon's `task.rename` RPC (same path
  // the outer app's `r` uses). Zoom for the dialog, like createTask, so
  // it matches the outer monitor's full-width look. The branch follows
  // the title for not-yet-materialised tasks (autoBranch derives from
  // it); a worktree that already exists keeps its git branch.
  async function renameTask(id: string): Promise<void> {
    const current = props.tasks().find((t) => t.id === id)
    if (!current) return
    const selfPane = process.env.TMUX_PANE
    if (selfPane) await runTmux(["resize-pane", "-Z", "-t", selfPane])
    try {
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
    } finally {
      if (selfPane) await runTmux(["resize-pane", "-Z", "-t", selfPane])
    }
  }

  // Gate on an empty dialog stack so typing "n" INTO a dialog field
  // doesn't re-fire createTask (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [{ key: "n", cmd: () => void createTask() }],
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
    if (!(await sessionExists(name))) {
      let cwd = props.tasks().find((t) => t.id === id)?.worktreePath
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
      await ensureSession({ name, cwd, command: ["claude"], taskId: id })
    }
    await runTmux(["switch-client", "-t", `=${name}`])
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <Sidebar
        tasks={props.tasks}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onActivate={(id) => void switchTo(id)}
        activateOnClick
        onAddTask={() => void createTask()}
        onRenameRequest={(id) => void renameTask(id)}
        focused={() => true}
      />
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
