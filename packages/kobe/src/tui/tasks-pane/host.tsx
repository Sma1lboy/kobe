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
 *     leaves delete/archive/rename/pin as no-ops.
 *   - Create: `n` (or the footer "+ New task") fires the daemon's
 *     `task.create` RPC — the first write-path here, the step toward
 *     retiring the outer "page 1". Repo is inherited from the cursor
 *     task (no repo picker). Backlog task, worktree lazy on first enter.
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
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import type { Task } from "../../types/task.ts"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { FocusProvider } from "../context/focus"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { useBindings } from "../lib/keymap"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { ensureSession } from "../panes/terminal/tmux.ts"
import { DialogProvider, useDialog } from "../ui/dialog"

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

  // `n` (and the footer "+ New task" click) creates a new task. The
  // standalone pane has no Orchestrator, so it fires the daemon's
  // `task.create` RPC — the same path the outer app uses. The repo is
  // inherited from the cursor task (fallback: first task in the list),
  // so there's no repo picker to build: a new task lands in whatever
  // repo you're already looking at. Created as a backlog task (no
  // worktree yet, matching the outer app); the worktree materialises on
  // first enter from the outer monitor. This is the first write-path in
  // the Tasks pane — the step toward retiring the outer "page 1".
  async function createTask(): Promise<void> {
    const list = props.tasks()
    const repo = (list.find((t) => t.id === selectedId()) ?? list[0])?.repo
    if (!repo) return
    const title = await RenameTaskDialog.show(dialog, "", { dialogTitle: "New task" })
    if (title === undefined) return
    try {
      const client = await connectOrStartDaemon()
      try {
        await client.request("task.create", { repo, title: title || undefined })
      } finally {
        client.close()
      }
    } catch (err) {
      console.error("[kobe tasks] task.create failed:", err)
      return
    }
    await props.reload()
  }

  // Gate on an empty dialog stack so typing "n" INTO the title input
  // doesn't re-fire createTask (the keymap sees inline-input keystrokes;
  // the dialog stack is the focus signal here).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [{ key: "n", cmd: () => void createTask() }],
  }))

  // Enter / click on a task → switch this tmux client to that task's
  // session. If the session isn't running yet we create it here —
  // but ONLY when the task's worktree already exists on disk (every
  // `main` task, and any worktree task that's been entered once). A
  // backlog task whose worktree was never materialised needs `git
  // worktree add`, which lives in the Orchestrator this standalone
  // pane doesn't have — those stay a no-op and the user enters them
  // from the outer monitor.
  async function switchTo(id: string): Promise<void> {
    const name = tmuxSessionName(id)
    if (!(await sessionExists(name))) {
      const task = props.tasks().find((t) => t.id === id)
      const cwd = task?.worktreePath
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
  // tasks created/renamed in the outer app show up here too.
  const store = new TaskIndexStore()
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
