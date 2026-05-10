/**
 * kobe application shell — full 5-pane Wave 3 layout.
 *
 * Layout (left → right): Sidebar | Chat | RightColumn{ FileTree, Preview, Terminal }
 *
 * Wiring:
 *   - Active task is selected in Sidebar (Stream F) and propagates a
 *     `selectedId` Solid signal that drives every other pane.
 *   - `worktreePath` is derived from the active task and feeds FileTree
 *     (Stream H), Preview (Stream I), and Terminal (Stream J).
 *   - FileTree's `onOpenFile` calls into Preview's imperative API, captured
 *     once via the `onOpen` callback.
 *   - Terminal owns one pty per task (resolved Wave 1 decision §5).
 *
 * Engine selection:
 *   - Default: `ClaudeCodeLocal` (subprocess wrapper around `claude` CLI).
 *   - With `KOBE_TEST_ENGINE=fake`: in-process `FakeAIEngine` plus a tiny
 *     HTTP side-channel on `KOBE_TEST_FAKE_PORT` for behavior tests to
 *     script events. The test pre-allocates the port and POSTs JSON to
 *     `/script` and `/finish`. Production never sets the env vars.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { render, useRenderer } from "@opentui/solid"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, removeSavedRepo } from "../state/repos.ts"
import type { ChatTab } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { buildEngine } from "./engine-bootstrap"
import { CenterTabStrip } from "./component/center-tab-strip"
import { HelpDialog } from "./component/help-dialog"
import { NewTaskDialog } from "./component/new-task-dialog"
import { PaneHeader } from "./component/pane-header"
import { RenameTaskDialog } from "./component/rename-task-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { StatusBar } from "./component/status-bar"
import { TopBar } from "./component/top-bar"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider, useKV } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, addTheme, useTheme } from "./context/theme"
import { loadUserThemes } from "./context/theme/loader"
import { useAppKeymap } from "./app-keymap"
import { usePaneSizes } from "./lib/use-pane-sizes"
import { useThemePersistence } from "./lib/use-theme-persistence"
import { Chat } from "./panes/chat/Chat"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "claude"

// Engine selection + fake-engine HTTP side-channel moved to
// `./engine-bootstrap.ts`. The side-channel is test-only — production
// builds never set `KOBE_TEST_ENGINE` / `KOBE_TEST_FAKE_PORT`.

// New-task dialog lives in `./component/new-task-dialog/` — see that
// module for the state machine (state.ts), the JSX shell (dialog.tsx),
// and the `NewTaskDialog.show(...)` entry point. Imported above.
//
// Rename-task dialog lives in `./component/rename-task-dialog/` and
// shares `stripNewlines` with the new-task dialog (opentui's `<input>`
// quirk that inserts a literal `\n` on Enter).

/* --------------------------------------------------------------------- */
/*  Top-level Shell                                                       */
/* --------------------------------------------------------------------- */

export type AppDeps = {
  orchestrator: KobeOrchestrator
}

// PaneHeader / StatusBar / TopBar moved to `./component/*.tsx` — they
// are pure rendering and don't share state with Shell. The `Hotkey`
// chip helper moved alongside StatusBar (it's only used there).

function Shell(props: AppDeps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()

  // Theme / KV round-trip — hydrate once on mount, then mirror every
  // change back. See `./lib/use-theme-persistence.ts` for the three
  // round-trips (activeTheme, transparentBackground, focusAccent) and
  // why the hydrate has to happen here rather than inside ThemeProvider.
  useThemePersistence(themeCtx, kv)

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()
  // Live per-task engine state (running / awaiting_input / idle) for
  // the sidebar status dot. Reactive — bumps whenever a task's tab
  // starts, finishes, or pauses on AskUserQuestion / ExitPlanMode.
  const chatRunStateAcc = props.orchestrator.chatRunStateSignal()
  // Persisted across runs in `~/.config/kobe/state.json` via the KV store
  // so reopening kobe lands on the task + center tab the user left from.
  // The auto-select effect below validates the persisted id against the
  // current task list (it may have been deleted between runs) and falls
  // back to tasks[0] when stale.
  const persistedSelectedId = kv.get("lastSelectedTaskId") as string | null | undefined
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  // Set by the new-task flow so the chat pane auto-submits the
  // prompt the user typed in the dialog. The chat clears it on
  // consumption to avoid re-submission on resubscribe.
  const [pendingPrompt, setPendingPrompt] = createSignal<{ taskId: string; prompt: string } | null>(null)
  /** Workspace header context meter (`12% · 24k/200k`), fed by the active chat tab. */
  const [workspaceContextAside, setWorkspaceContextAside] = createSignal<string | null>(null)

  // Background npm-registry version check. Cached for 6h on disk, so
  // typical cold boots return synchronously off the cache. The first
  // launch (or once per cache window) hits the network with a 3s
  // timeout — failures are silent, the chip just doesn't render.
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null)
  onMount(() => {
    void checkLatestVersion()
      .then((info) => {
        if (info) setUpdateInfo(info)
      })
      .catch(() => {
        /* swallow — version check is best-effort */
      })
  })

  const activeTask = createMemo(() => {
    const id = selectedId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })

  // Accessor for the chat pane that yields a prompt only when it
  // matches the currently active task. This keeps the chat from
  // auto-submitting a leftover prompt against the wrong task after
  // a switch.
  const taskIdAcc = createMemo(() => selectedId() ?? undefined)
  createEffect(
    on(taskIdAcc, () => {
      setWorkspaceContextAside(null)
    }),
  )
  const activeTitleAcc = createMemo(() => activeTask()?.title)
  const pendingPromptForActive = createMemo(() => {
    const pp = pendingPrompt()
    if (!pp) return undefined
    if (pp.taskId !== selectedId()) return undefined
    return pp.prompt
  })
  // Per-task accessors for the right-column panes. FileTree + Preview key
  // off `worktreePath`; Terminal keys off both `cwd` and `taskId` (so the
  // pty registry can deduplicate per task per the resolved Wave-1 decision).
  //
  // Empty string is normalised to null: orchestrator.createTask publishes
  // a transient placeholder task with worktreePath="" before the worktree
  // is actually written to disk. Treating "" as a real path would call
  // `git ls-files` with cwd="" and crash. The placeholder window is short
  // (one git worktree add) but the subscribers see it.
  const worktreePathAcc = createMemo<string | null>(() => {
    const path = activeTask()?.worktreePath
    return path ? path : null
  })
  const taskIdNullAcc = createMemo<string | null>(() => selectedId())
  // Diff base — for v1, just compare against HEAD (working-tree changes).
  // Wave 4 polish makes this configurable per-task (e.g. branch fork point).
  const diffBaseAcc = createMemo<string | null>(() => (worktreePathAcc() ? "HEAD" : null))

  // FileTree → Preview wiring: capture Preview's imperative API once,
  // then route file-tree clicks/enters into Preview.open(). Plus the
  // outer center-column tab state below tracks which file tab is active.
  const [previewApi, setPreviewApi] = createSignal<PreviewApi | null>(null)

  /* ------------------------------------------------------------------- */
  /*  Pane sizing — three <ResizableEdge /> splitters + keyboard nudger   */
  /* ------------------------------------------------------------------- */
  // All size signals, KV round-trip, and the clamp helpers live in
  // `./lib/use-pane-sizes.ts`. The hook also owns the keyboard-resize
  // `nudge(delta, focused)` that we thread into the app-keymap below.
  const paneSizes = usePaneSizes(kv)
  const { sidebarWidth, setSidebarWidth, workspaceWidth, setWorkspaceWidth, filesHeight, setFilesHeight } = paneSizes
  const { clampSidebar, clampWorkspace, clampFiles } = paneSizes

  /* ------------------------------------------------------------------- */
  /*  Pane focus — backed by FocusContext (src/tui/context/focus.tsx)     */
  /* ------------------------------------------------------------------- */
  const focus = useFocus()
  const focusedPane = focus.focused
  const setFocusedPane = focus.setFocused
  // Renderer handle — only used by the quit-confirm path so we can
  // tear down opentui state (mouse tracking, alt-screen, raw mode)
  // before process.exit. Without this the parent shell sees mouse
  // escape sequences leaking past kobe's exit.
  const renderer = useRenderer()
  // Pane-bindings-active accessor: true only when (a) the pane is the
  // focused one AND (b) no dialog is open. The dialog gate prevents
  // sidebar/files/terminal bindings from firing while the user is
  // typing into a dialog input — `d` typed into a path field would
  // otherwise trigger the sidebar's delete-task confirmation.
  const isFocused = (pane: PaneId): Accessor<boolean> => {
    const baseAcc = focus.is(pane)
    return () => baseAcc() && dialog.stack.length === 0
  }

  // ctrl+hjkl pane focus. h/j/k/l → sidebar / workspace / files /
  // terminal (ordinal 1/2/3/4 mapped onto the vim row). ctrl+letter
  // chords have stable C0 control byte mappings, so they work in
  // every terminal + tmux config without CSI-u / kitty keyboard /
  // per-user setup. The handler reads `evt.name` to dispatch.
  const FOCUS_HJKL_TARGETS: Record<string, PaneId> = {
    h: "sidebar",
    j: "workspace",
    k: "files",
    l: "terminal",
  }

  // Keyboard-resize step. The grow/shrink direction comes from the
  // chord; the per-pane nudge logic lives in `paneSizes.nudge`.
  const RESIZE_STEP = 2
  const nudgeFocusedPane = (delta: number): void => paneSizes.nudge(delta, focusedPane())
  // Note: the actual `useBindings(...)` calls for focus.numeric and
  // pane.resize live in `useAppKeymap(...)` below — see app-keymap.tsx
  // for the full priority stack.

  // Tab / shift+tab pane cycling is registered via `useKobeKeybindings`'s
  // onFocusNext / onFocusPrev callbacks below — we just gate them here
  // (no-op when workspace is focused so opentui's textareas can claim
  // tab for their own intra-input behavior).

  /* ------------------------------------------------------------------- */
  /*  Center-column tab state — per-task                                  */
  /* ------------------------------------------------------------------- */
  // Per the resolved Wave-1 invariant ("each sidebar session = one
  // worktree") and Jackson's call (KOB-20): the workspace shows a chat
  // tab plus AT MOST ONE file tab. Each click in the file tree replaces
  // whatever file was previously open — the chip swaps its label and the
  // preview re-renders. No accumulation of file chips. Switching tasks
  // restores the active tab exactly.
  type CenterTab = "chat" | { kind: "file"; path: string }
  type TaskCenterTabs = { active: CenterTab }
  const EMPTY_TABS: TaskCenterTabs = { active: "chat" }
  // Hydrate from KV. Stored as a plain object keyed by taskId because Maps
  // aren't JSON-serializable. Tasks deleted between runs leak entries into
  // the file; harmless and pruned the next time we persist after a real
  // selection change. (Could prune on hydrate if it ever matters.)
  // Backwards-compat: pre-KOB-20 entries had a `string[]` under `open`;
  // we drop the field on hydrate. `active` survives the migration verbatim
  // — if it pointed at a file path, the new state still opens that file.
  const persistedTabs = kv.get("centerTabsByTask") as Record<string, { active?: CenterTab; open?: unknown }> | undefined
  const [tabsByTask, setTabsByTask] = createSignal(
    new Map<string, TaskCenterTabs>(
      persistedTabs
        ? Object.entries(persistedTabs).map(([id, raw]) => [id, { active: raw?.active ?? "chat" }] as const)
        : [],
    ),
  )

  const currentTabs = createMemo<TaskCenterTabs>(() => {
    const id = selectedId()
    if (!id) return EMPTY_TABS
    return tabsByTask().get(id) ?? EMPTY_TABS
  })
  const activeCenterTab = createMemo<CenterTab>(() => currentTabs().active)
  const isChatTabActive = createMemo<boolean>(() => activeCenterTab() === "chat")
  const activeFileTabPath = createMemo<string | null>(() => {
    const a = activeCenterTab()
    return typeof a === "object" ? a.path : null
  })

  function mutateTabs(taskId: string, updater: (cur: TaskCenterTabs) => TaskCenterTabs): void {
    setTabsByTask((prev) => {
      const next = new Map(prev)
      const cur = next.get(taskId) ?? EMPTY_TABS
      next.set(taskId, updater(cur))
      return next
    })
  }

  /** Helper: tell Preview to drop whichever file (if any) is currently
   *  open, so its internal tab list stays at most one entry. */
  function dropPreviousFileFromPreview(cur: TaskCenterTabs, except?: string): void {
    if (typeof cur.active === "object" && cur.active.kind === "file" && cur.active.path !== except) {
      previewApi()?.close(cur.active.path)
    }
  }

  function openFileInCenter(relPath: string): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs(), relPath)
    mutateTabs(id, () => ({ active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    // Focus stays on whichever pane the user was in (typically FILES,
    // since that's where the click/enter happened). Jackson explicitly
    // does NOT want this to pull focus to the workspace — the open is
    // a content swap in the centre, not a navigation.
  }

  function selectChatTab(): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs())
    mutateTabs(id, () => ({ active: "chat" }))
    setFocusedPane("workspace")
  }

  // Chat tabs (multitab) — pulled off the active task so the
  // CenterTabStrip can render one chip per chat tab alongside the
  // (single) file chip. activeChatTabIdAcc tracks which chat tab the
  // orchestrator currently considers active; click-to-switch on a
  // chip flows through `selectChatTabById` which in turn calls
  // orchestrator.setActiveTab + flips the workspace tab to chat.
  const activeChatTabsAcc = createMemo<readonly ChatTab[]>(() => activeTask()?.tabs ?? [])
  const activeChatTabIdAcc = createMemo<string | null>(() => activeTask()?.activeTabId ?? null)
  function selectChatTabById(tabId: string): void {
    const id = selectedId()
    if (!id) return
    void props.orchestrator.setActiveTab(id, tabId).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setActiveTab failed:", err)
    })
    dropPreviousFileFromPreview(currentTabs())
    mutateTabs(id, () => ({ active: "chat" }))
    setFocusedPane("workspace")
  }

  function selectFileTab(relPath: string): void {
    // Single file tab: clicking it just keeps it active. The previous
    // file (if any other path) was already dropped when this one was
    // opened — we don't need to drop it again here. Keep the function
    // for symmetry with the chat-tab handlers + future re-entry.
    const id = selectedId()
    if (!id) return
    mutateTabs(id, () => ({ active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    setFocusedPane("workspace")
  }

  function closeFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    dropPreviousFileFromPreview(currentTabs(), undefined)
    mutateTabs(id, () => ({ active: "chat" }))
    void relPath
  }

  // Auto-select on first task availability. Prefer the persisted task
  // from the previous run when it still exists; otherwise fall back to
  // tasks[0]. The `persistedSelectedId` reference is consumed exactly
  // once (we null it after the first successful match) so user-driven
  // selections later in the session aren't snapped back.
  let pendingPersistedId: string | null = persistedSelectedId ?? null
  createEffect(() => {
    const tasks = tasksAcc()
    if (selectedId()) return
    if (tasks.length === 0) return
    const persisted = pendingPersistedId ? tasks.find((t) => t.id === pendingPersistedId) : undefined
    pendingPersistedId = null
    setSelectedId((persisted ?? tasks[0])!.id)
  })

  // Persist the active task and per-task tab state whenever they
  // change. The KV store debounces writes internally so this is cheap.
  createEffect(() => {
    kv.set("lastSelectedTaskId", selectedId())
  })
  createEffect(() => {
    const obj: Record<string, TaskCenterTabs> = {}
    for (const [id, tabs] of tabsByTask()) obj[id] = tabs
    kv.set("centerTabsByTask", obj)
  })

  // Saved repos — populated by the `kobe add [path]` CLI subcommand
  // (src/cli/index.ts), read here for the new-task dialog's repo
  // picker. Reading through a memo over kv.store keeps the picker
  // reactive on the same kobe instance. Defensive filter in case the
  // on-disk file was hand-edited to a non-array.
  const savedRepos = createMemo<readonly string[]>(() => {
    const raw = kv.get("savedRepos", [])
    if (!Array.isArray(raw)) return []
    return raw.filter((s): s is string => typeof s === "string")
  })

  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
    onFocusDetach: () => setFocusedPane("sidebar"),
    // Tab cycle is no-op while workspace is focused so the composer's
    // own tab handling (dialog field cycling, indent, etc.) wins.
    onFocusNext: () => {
      if (focusedPane() !== "workspace") focus.cycle(1)
    },
    onFocusPrev: () => {
      if (focusedPane() !== "workspace") focus.cycle(-1)
    },
  })

  // Shared "open new-task dialog and create" handler. Bound to two
  // keys with different `enabled` guards (see useBindings calls below).
  async function openNewTaskFlow(): Promise<void> {
    // Default the dialog to the last repo the user picked, falling
    // back to cwd. Persisted via KV so it survives kobe restarts.
    const lastRepo = (() => {
      const raw = kv.get("lastNewTaskRepo")
      return typeof raw === "string" && raw.trim() ? raw : process.cwd()
    })()
    const result = await NewTaskDialog.show(dialog, lastRepo, savedRepos())
    if (!result) return
    try {
      // Dialog no longer asks for a first prompt — orchestrator gives
      // the task PLACEHOLDER_TASK_TITLE and back-fills it from the
      // user's first composer submit (see runTask). The user lands on
      // the chat composer ready to type.
      const created = await props.orchestrator.createTask({
        repo: result.repo,
        baseRef: result.baseRef,
      })
      kv.set("lastNewTaskRepo", result.repo)
      setSelectedId(created.id)
      // Pull focus to the chat pane so the user can immediately type
      // / use chat-pane-scoped keybindings (ctrl+t for new chat tab,
      // ctrl+1..9 / ctrl+tab to navigate tabs, ctrl+w to close one)
      // without an extra ctrl+2. Mirrors the sidebar's onSelect
      // behaviour — both "user wants to look at this task" entry
      // points should land in the same place.
      setFocusedPane("workspace")
    } catch (err) {
      // Surface failure as stderr; we don't have a global banner yet,
      // and the chat pane may not be subscribed (no task selected).
      // eslint-disable-next-line no-console
      console.error("[kobe] createTask failed:", err)
    }
  }

  /**
   * Confirm + delete a task. Wired from the sidebar's `d` keypress
   * (and a future right-click in Wave 4). Per CLAUDE.md the user's
   * `d` press IS the explicit consent for clearing the worktree, but
   * we still gate behind a confirm because the action is destructive
   * and out-of-frame state (other terminal windows, in-progress writes)
   * could mean "press the wrong key once" → "lose work."
   */
  /**
   * Open the rename dialog for a task and persist the new title.
   * Mirrors `confirmDeleteTask` in shape: resolve task → run dialog →
   * await orchestrator. The orchestrator's `setTitle` does its own
   * empty-title rejection and same-as-current no-op, so we only need
   * to gate on "did the user submit a value at all" here. The dialog
   * itself rejects empty submits before calling onSubmit, so a
   * resolved-with-string from the promise is always usable.
   */
  async function confirmRenameTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const next = await RenameTaskDialog.show(dialog, task.title)
    if (next === undefined) return
    try {
      await props.orchestrator.setTitle(taskId, next)
    } catch (err) {
      // Empty/whitespace-only — defensive: dialog's commit() filters
      // these but a future code path could call this with anything.
      // eslint-disable-next-line no-console
      console.error("[kobe] setTitle failed:", err)
    }
  }

  /**
   * Open the rename dialog for the active chat tab on the active task
   * and persist the new label. Mirrors `confirmRenameTask` shape but
   * targets `tabs[i].title` instead of `task.title`. Pre-fills with
   * the current label (or the auto-derived `chat N` fallback if the
   * tab has never been named).
   */
  async function confirmRenameChatTab(tabId: string): Promise<void> {
    const taskId = selectedId()
    if (!taskId) return
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    const tab = task.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const fallback = `chat ${tab.seq}`
    const current = tab.title && tab.title.length > 0 ? tab.title : fallback
    const next = await RenameTaskDialog.show(dialog, current, { dialogTitle: "Rename chat tab" })
    if (next === undefined) return
    try {
      await props.orchestrator.setTabTitle(taskId, tabId, next)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] setTabTitle failed:", err)
    }
  }

  async function confirmDeleteTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
    // KOB-15: pressing `d` on a pinned "main" task row does NOT delete
    // the user's actual repo. Instead the row is bound to a saved-
    // repos entry; the destructive verb is "remove from saved repos."
    // The directory and its files stay on disk; the task is archived
    // (not removed from the manifest) so a re-add via `kobe add` is
    // symmetric — `ensureMainTask` finds and unarchives it.
    if (task.kind === "main") {
      const repoLabel = task.repo.split("/").filter(Boolean).pop() ?? task.repo
      const ok = await DialogConfirm.show(
        dialog,
        `Remove '${repoLabel}' from saved repos?`,
        `This will remove '${repoLabel}' from your saved repos. The directory and its files stay on disk.`,
        "cancel",
      )
      if (ok !== true) return
      try {
        removeSavedRepo(task.repo)
        await props.orchestrator.setArchived(task.id, true)
        if (selectedId() === task.id) setSelectedId(null)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[kobe] remove saved repo failed:", err)
      }
      return
    }
    const ok = await DialogConfirm.show(
      dialog,
      `Delete '${task.title}'?`,
      `Removes the worktree at ${task.worktreePath}, deletes the chat history, and removes the task. This cannot be undone. The git branch is kept.`,
      "cancel",
    )
    if (ok !== true) return
    try {
      await props.orchestrator.deleteTask(taskId)
      // If the deleted task was the selected one, clear selection so the
      // chat pane / file tree etc. stop pointing at a dead worktree.
      if (selectedId() === taskId) setSelectedId(null)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] deleteTask failed:", err)
    }
  }

  // Centralised keymap registration. All six top-level useBindings
  // call sites used to live inline here; they were consolidated into
  // app-keymap.tsx so the priority stack + scope rationale are
  // visible in one place. See that file for the registration order
  // and the rule about plain-letter vs modifier-prefixed chords.
  useAppKeymap({
    dialog,
    focusedPane,
    setFocusedPane,
    nudgeFocusedPane,
    resizeStep: RESIZE_STEP,
    focusHjklTargets: FOCUS_HJKL_TARGETS,
    openNewTaskFlow,
    kv,
    orchestrator: props.orchestrator,
    renderer,
    activeTask,
  })

  // Side-channel PR trigger for the W4.PR behavior test. When
  // KOBE_TEST_FAKE_PORT is active, the fake-engine HTTP server (started
  // in startApp) also exposes POST /pr which calls requestPR for the
  // active task. The test uses this in preference to keystroke-driven
  // invocation because key dispatch interacts with the focused
  // composer's keymap in ways the test shouldn't have to debug. We
  // expose the trigger via a global window-attached function so the
  // server (defined at startApp time, before Shell mounts) can reach it.
  if (typeof globalThis !== "undefined") {
    ;(globalThis as { __kobeTestRequestPR?: () => Promise<{ taskId: string; prompt: string }> }).__kobeTestRequestPR =
      async () => {
        const task = activeTask()
        if (!task || !task.worktreePath || task.status === "canceled") {
          throw new Error("no usable active task for PR (no worktree, no task, or canceled)")
        }
        // Render the prompt OUTSIDE of requestPR so the test can assert
        // on what was actually sent. This duplicates a tiny bit of logic
        // for the test affordance only — production goes through
        // requestPR which independently renders + sends.
        const { gatherPRState, loadPRInstructionsTemplate, renderPRInstructions } = await import(
          "../orchestrator/pr/index.ts"
        )
        const state = await gatherPRState(task.worktreePath)
        const template = await loadPRInstructionsTemplate(task.worktreePath)
        const rendered = renderPRInstructions(template, state)
        await props.orchestrator.requestPR(task.id)
        return { taskId: task.id, prompt: rendered }
      }

    // Side-channel respond trigger for the user-input pause behavior
    // tests (ExitPlanMode + AskUserQuestion). The chat row's
    // mouse-click path through onApprove/onAnswer eventually calls
    // orchestrator.respondToInput, but driving that from a PTY test
    // requires SGR mouse delivery the screen-capture path doesn't
    // honor. We expose a server-side hook that picks the latest
    // pending requestId for the active task and dispatches the
    // user's response synthetically. The render side (status flip on
    // the picker, composer unlock, synthetic user.inject row) is the
    // same code path real clicks would exercise — only the
    // input-event delivery differs.
    type RespondTrigger = (
      response: import("../types/engine.ts").UserInputResponse,
    ) => Promise<{ taskId: string; requestId: string; prompt: string }>
    ;(globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput = async (response) => {
      const task = activeTask()
      if (!task) throw new Error("no active task for respondToInput")
      const pending = props.orchestrator.peekPendingInput(task.id)
      if (pending.length === 0) {
        throw new Error("no pending input for active task — picker hasn't rendered yet?")
      }
      // Latest request wins. Multiple pending requests on one task is
      // not currently a real flow (the orchestrator kills the
      // subprocess on the first user-input tool start), but if it
      // becomes one the test can extend the seam with an explicit
      // requestId selector.
      const latest = pending[pending.length - 1]
      if (!latest) throw new Error("no pending input for active task — picker hasn't rendered yet?")
      const { renderUserInputResponsePrompt } = await import("../orchestrator/core.ts")
      const prompt = renderUserInputResponsePrompt(latest.payload, response)
      await props.orchestrator.respondToInput(task.id, latest.requestId, response)
      return { taskId: task.id, requestId: latest.requestId, prompt }
    }
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar orchestrator={props.orchestrator} activeTask={activeTask} updateInfo={updateInfo} />
      <box flexDirection="row" flexGrow={1}>
        {/* Left: task sidebar. Click anywhere on the sidebar pane to
            focus it. The right edge is a separate <ResizableEdge /> that
            owns the drag-to-resize affordance plus hover/focus colors.
            backgroundPanel paints a slightly-raised tone vs the chat
            (which keeps `theme.background`) — IDE convention is the
            auxiliary rails recede in saturation, the work area is the
            visual focus. */}
        <box
          flexShrink={0}
          flexDirection="column"
          backgroundColor={theme.backgroundPanel}
          onMouseUp={() => setFocusedPane("sidebar")}
        >
          <Sidebar
            width={sidebarWidth}
            tasks={tasksAcc}
            onSelect={(id: string) => {
              setSelectedId(id)
              // Selecting a task usually means "I want to look at it" —
              // pull focus to workspace so the user can immediately type
              // / scroll without another ctrl+2.
              setFocusedPane("workspace")
            }}
            onDeleteRequest={(id: string) => {
              void confirmDeleteTask(id)
            }}
            onArchiveRequest={(id: string) => {
              void props.orchestrator.setArchived(id).catch((err) => {
                // eslint-disable-next-line no-console
                console.error("[kobe] setArchived failed:", err)
              })
            }}
            onRenameRequest={(id: string) => {
              void confirmRenameTask(id)
            }}
            onPinRequest={(id: string) => {
              void props.orchestrator.setPinned(id).catch((err) => {
                // eslint-disable-next-line no-console
                console.error("[kobe] setPinned failed:", err)
              })
            }}
            onAddTask={() => void openNewTaskFlow()}
            selectedId={selectedId}
            focused={isFocused("sidebar")}
          />
        </box>
        {/* Sidebar ↔ workspace splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={sidebarWidth}
          setSize={setSidebarWidth}
          clamp={clampSidebar}
          focused={isFocused("sidebar")}
        />
        {/* Center: tabbed (chat | <file>...) — primary interaction surface.
            Width controlled by workspaceWidth; the right edge is a
            <ResizableEdge /> sibling rather than a `border={["right"]}`
            on this box. No bg paint — the chat body inherits the
            renderer's `theme.background` (which the ThemeProvider
            forces to transparent under the transparent-bg toggle).
            Only the composer's `theme.backgroundElement` fill stays
            tinted in transparent mode, keeping the input area
            legible against any host wallpaper. */}
        <box
          flexDirection="column"
          flexShrink={0}
          width={workspaceWidth()}
          onMouseUp={() => setFocusedPane("workspace")}
        >
          <PaneHeader
            title="WORKSPACE"
            ordinal="j"
            subtitle={activeTask()?.title ?? "no task"}
            asideRight={isChatTabActive() ? (workspaceContextAside() ?? undefined) : undefined}
            focused={focusedPane() === "workspace"}
          />
          <CenterTabStrip
            isChatActive={isChatTabActive}
            activeFile={activeFileTabPath}
            chatTabs={activeChatTabsAcc}
            activeChatTabId={activeChatTabIdAcc}
            activeTaskId={taskIdAcc}
            chatRunState={chatRunStateAcc}
            onSelectChat={selectChatTab}
            onSelectChatTab={selectChatTabById}
            onSelectFile={selectFileTab}
            onCloseFile={closeFileTab}
          />
          <box flexGrow={1}>
            <Show
              when={isChatTabActive()}
              fallback={
                <Preview
                  worktreePath={worktreePathAcc}
                  diffBase={diffBaseAcc}
                  onOpen={(api) => setPreviewApi(api)}
                  hideInternalTabs={() => true}
                  onExternalClose={closeFileTab}
                  focused={isFocused("workspace")}
                />
              }
            >
              <Chat
                orchestrator={props.orchestrator}
                taskId={taskIdAcc}
                title={activeTitleAcc}
                pendingPrompt={pendingPromptForActive}
                onPendingPromptConsumed={() => setPendingPrompt(null)}
                focused={isFocused("workspace")}
                onContextMeter={(label) => setWorkspaceContextAside(label)}
                onRenameTabRequest={(tabId: string) => {
                  void confirmRenameChatTab(tabId)
                }}
              />
            </Show>
          </box>
        </box>
        {/* Workspace ↔ right column splitter. */}
        <ResizableEdge
          orientation="vertical"
          size={workspaceWidth}
          setSize={setWorkspaceWidth}
          clamp={clampWorkspace}
          focused={isFocused("workspace")}
        />
        {/* Right column: FILES top + TERMINAL bottom. Width absorbs the
            remainder via flexGrow={1}; the FILES↔TERMINAL split is a
            <ResizableEdge orientation="horizontal" /> with a controlled
            filesHeight signal driving the upper pane. Same
            backgroundPanel tone as the sidebar so the two rails feel
            symmetric and the chat in the middle is visibly the focus. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} backgroundColor={theme.backgroundPanel}>
          <box flexShrink={0} height={filesHeight()} flexDirection="column" onMouseUp={() => setFocusedPane("files")}>
            <PaneHeader title="FILES" ordinal="k" focused={focusedPane() === "files"} />
            <box flexGrow={1}>
              <FileTree worktreePath={worktreePathAcc} onOpenFile={openFileInCenter} focused={isFocused("files")} />
            </box>
          </box>
          {/* Files ↔ terminal splitter. */}
          <ResizableEdge
            orientation="horizontal"
            size={filesHeight}
            setSize={setFilesHeight}
            clamp={clampFiles}
            focused={isFocused("files")}
          />
          <box
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            flexDirection="column"
            onMouseUp={() => setFocusedPane("terminal")}
          >
            <PaneHeader
              title="TERMINAL"
              ordinal="l"
              subtitle={worktreePathAcc() ? worktreePathAcc()?.split("/").slice(-1)[0] : undefined}
              focused={focusedPane() === "terminal"}
            />
            <box flexGrow={1}>
              <Terminal cwd={worktreePathAcc} taskId={taskIdNullAcc} focused={isFocused("terminal")} />
            </box>
          </box>
        </box>
      </box>
      <StatusBar />
    </box>
  )
}

function App(props: AppDeps) {
  return (
    <ThemeProvider mode="dark" theme={DEFAULT_THEME}>
      <KVProvider>
        <SyncProvider>
          <DialogProvider>
            <CommandPaletteProvider>
              <FocusProvider>
                <Shell {...props} />
              </FocusProvider>
            </CommandPaletteProvider>
          </DialogProvider>
        </SyncProvider>
      </KVProvider>
    </ThemeProvider>
  )
}

/**
 * Mount the G2 app. Builds the orchestrator stack, then renders
 * `<App />`. Replaces `tui/index.tsx`'s previous banner mount.
 */
export async function startApp(): Promise<void> {
  // Register user-installed themes (`~/.kobe/themes/*.json`) BEFORE the
  // ThemeProvider mounts. ThemeProvider's `init` reads the active theme
  // out of the registry; if the user persisted a theme that lives in a
  // user file, it has to exist by registry time or the provider falls
  // back to the bundled default. Sync — see loader.ts header for why.
  for (const { name, theme } of loadUserThemes()) {
    addTheme(name, theme)
  }
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  let orchestrator: KobeOrchestrator
  if (process.env.KOBE_TEST_ENGINE || process.env.KOBE_NO_DAEMON === "1") {
    const engine = await buildEngine()
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const worktrees = new GitWorktreeManager()
    orchestrator = new Orchestrator({ engine, store, worktrees })
    // Bridge: bind a Unix-socket RPC server + write an MCP config so
    // every claude subprocess kobe spawns gets the `kobe_*` tools.
    try {
      const { startBridge } = await import("../orchestrator/bridge/index.ts")
      await startBridge(orchestrator, { homeDir })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[kobe] bridge failed to start:", err)
    }
  } else {
    const client = await connectOrStartDaemon()
    orchestrator = new RemoteOrchestrator(client)
    await orchestrator.init()
  }
  // KOB-15: seed a pinned "main" task per saved repo. Idempotent:
  // ensureMainTask returns the existing main task on subsequent boots.
  // We read savedRepos from `state/repos.ts` (which honours
  // KOBE_HOME_DIR) rather than from the TUI's KV context — KV isn't
  // mounted yet, and we want behavior tests with a tmpdir HOME to see
  // the seeding too. Failures per repo are logged and swallowed so a
  // single bad path can't gate the whole UI from booting.
  for (const repo of getSavedRepos()) {
    try {
      await orchestrator.ensureMainTask(repo)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[kobe] ensureMainTask failed for ${repo}:`, err)
    }
  }
  // Renderer-level background: transparent so the host terminal's
  // background (theme, image, transparency setting) shows through where
  // panes don't paint. opentui PR #824 / v0.1.89+ added this — earlier
  // versions composited transparent regions against opaque black.
  // exitOnCtrlC: false — opentui's default kills the process on a single
  // Ctrl+C. Jackson wants the standard "first press copies / arms,
  // second press quits" UX, owned by useKobeKeybindings.
  // useKittyKeyboard:{} — opt into the kitty / CSI-u keyboard
  // protocol. Without this, modifier-prefixed digit chords
  // (ctrl+1..4 for pane focus) don't fire in most terminals because
  // ctrl+<digit> isn't a distinct byte sequence in legacy terminal
  // mode — the ctrl modifier is silently dropped. Kitty/foot/iTerm2/
  // recent Terminal.app reply to the enable sequence and start
  // sending CSI-u events with full modifier info. tmux users need
  // `set -g extended-keys on` (and recent enough tmux) for the
  // sequences to pass through. Non-supporting terminals fall back
  // to legacy mode silently — no regression, just no ctrl+digit.
  await render(() => <App orchestrator={orchestrator} />, {
    backgroundColor: "transparent",
    exitOnCtrlC: false,
    useKittyKeyboard: {},
  })
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
