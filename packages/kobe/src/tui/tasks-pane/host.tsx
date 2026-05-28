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
 *   - Read-only: loads `~/.kobe/tasks.json` directly and re-reads on a
 *     timer. The outer app's Orchestrator / Daemon own writes; this
 *     pane never mutates (delete/archive/rename/pin are no-ops here).
 *   - Switch only: Enter `switch-client`s to a task's EXISTING session.
 *     A task that's never been entered has no session to switch to —
 *     creating one needs the Orchestrator (worktree alloc), which this
 *     standalone pane process doesn't have. Those land back in the
 *     outer monitor.
 */

import { runTmux, sessionExists, tmuxSessionName } from "@/tmux/client"
import { render } from "@opentui/solid"
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js"
import { TaskIndexStore } from "../../orchestrator/index/store.ts"
import type { Task } from "../../types/task.ts"
import { FocusProvider } from "../context/focus"
import { ThemeProvider, addTheme, useTheme } from "../context/theme"
import { loadUserThemes } from "../context/theme/loader"
import { readPersistedUiPrefs } from "../lib/persisted-ui-prefs"
import { Sidebar } from "../panes/sidebar/Sidebar"
import { DialogProvider } from "../ui/dialog"

const FALLBACK_THEME = "claude"
const RELOAD_MS = 1500

function TasksShell(props: {
  tasks: Accessor<readonly Task[]>
  transparent: boolean
  focusAccent: ReturnType<typeof readPersistedUiPrefs>["focusAccent"]
}) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const [selectedId, setSelectedId] = createSignal<string | null>(props.tasks()[0]?.id ?? null)

  onMount(() => {
    themeCtx.setTransparentBackground(props.transparent)
    if (props.focusAccent) themeCtx.setFocusAccent(props.focusAccent)
  })

  // Enter on a task → switch this tmux client to that task's session,
  // if it's running. No-op (with a log) when the session doesn't exist
  // yet — that task hasn't been entered, and creating it needs the
  // Orchestrator which this pane doesn't have.
  async function switchTo(id: string): Promise<void> {
    const name = tmuxSessionName(id)
    if (!(await sessionExists(name))) return
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
  const timer = setInterval(() => {
    void store.load().then(() => setTasks(store.list()))
  }, RELOAD_MS)

  await render(
    () => (
      <ThemeProvider mode="dark" theme={prefs.theme}>
        <FocusProvider initial="sidebar">
          <DialogProvider>
            <TasksShell tasks={tasks} transparent={prefs.transparent} focusAccent={prefs.focusAccent} />
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
