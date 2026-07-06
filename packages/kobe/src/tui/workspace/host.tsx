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
import { Show, createEffect, createMemo, createSignal, on } from "solid-js"
import { RemoteOrchestrator } from "../../client/remote-orchestrator.ts"
import { interactiveEngineCommand } from "../../engine/interactive-command.ts"
import { resolveEditorLaunch } from "../../tmux/editor-launch.ts"
import { DEFAULT_TASK_VENDOR, type Task } from "../../types/task.ts"
import { HelpDialog } from "../component/help-dialog"
import { SettingsDialog } from "../component/settings-dialog"
import { type PaneId, useFocus } from "../context/focus"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { bootPaneHost } from "../lib/host-boot"
import { useBindings } from "../lib/keymap"
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
const PANE_BY_SLOT = ["sidebar", "workspace", "files"] as const satisfies readonly PaneId[]

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
  const [selectedId, setSelectedId] = createSignal<string | null>(props.orchestrator.activeTaskSignal()())
  const [sidebarHover, setSidebarHover] = createSignal<SidebarHover | null>(null)

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
   * Deliberately does NOT move focus to the workspace pane — opening a file
   * is a content swap, not a navigation (rejected twice previously when it
   * pulled focus; see KOB-25).
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

  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen(),
    bindings: [
      ...bindByIds({
        "help.open": () => HelpDialog.show(dialog),
        "focus.numeric": (_evt, slot) => {
          const pane = PANE_BY_SLOT[slot ?? 0]
          if (pane) focus.setFocused(pane)
        },
      }),
    ],
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && !focus.is("sidebar")(),
    bindings: bindByIds({
      "focus.sidebar": () => focus.setFocused("sidebar"),
    }),
  }))
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !settingsOpen() && focus.is("sidebar")(),
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
          />
        </box>

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
          />
        </box>

        <SidebarHoverTooltip hover={sidebarHover} dims={dims} />
      </box>
    </Show>
  )
}

function ShowWorkspace(props: {
  task: Task | undefined
  worktree: string | null
  orchestrator: RemoteOrchestrator
  focused: () => boolean
  onEditorTabReady: (open: (command: readonly string[], label: string) => void) => void
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
