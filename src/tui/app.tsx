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
import { basename, join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { type Accessor, For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"
import { HSplitBorder, SplitBorder } from "./component/border"
import { HelpDialog } from "./component/help-dialog"
import { CommandPaletteProvider } from "./context/command-palette"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { useBindings } from "./lib/keymap"
import { Chat } from "./panes/chat/Chat"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { type DialogContext, DialogProvider, useDialog } from "./ui/dialog"

const DEFAULT_THEME = "tokyonight"

/* --------------------------------------------------------------------- */
/*  Engine selection + fake-engine side-channel                           */
/* --------------------------------------------------------------------- */

/**
 * Build the AI engine the orchestrator will drive. Test mode uses
 * `FakeAIEngine` and mounts the side-channel HTTP server.
 */
async function buildEngine(): Promise<AIEngine> {
  if (process.env.KOBE_TEST_ENGINE === "fake") {
    // Late import — keep test-only deps out of production bundles.
    const { FakeAIEngine } = await import("../../test/behavior/fake-engine.ts")
    const fake = new FakeAIEngine()
    await mountFakeEngineServer(fake)
    return fake
  }
  return new ClaudeCodeLocal()
}

/**
 * Tiny HTTP side-channel for the G2 behavior test. The test pre-allocates
 * a port (via `KOBE_TEST_FAKE_PORT`) and POSTs scripted events to it.
 * Kobe runs in a child process so we can't share the FakeAIEngine
 * instance via memory; HTTP is the simplest cross-process scripting
 * mechanism that works under Bun + macOS without extra deps.
 */
async function mountFakeEngineServer(fake: import("../../test/behavior/fake-engine.ts").FakeAIEngine): Promise<void> {
  const portStr = process.env.KOBE_TEST_FAKE_PORT
  if (!portStr) return
  const port = Number(portStr)
  if (!Number.isFinite(port)) return

  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    if (req.method !== "POST" && req.method !== "GET") {
      res.writeHead(405).end()
      return
    }
    let body = ""
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8")
    })
    req.on("end", () => {
      try {
        if (req.url === "/script" && req.method === "POST") {
          const { sessionId, events } = JSON.parse(body) as { sessionId: string; events: unknown[] }
          fake.script(sessionId, events as Parameters<typeof fake.script>[1])
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        if (req.url === "/finish" && req.method === "POST") {
          const { sessionId } = JSON.parse(body) as { sessionId: string }
          fake.finish(sessionId)
          res.writeHead(200, { "content-type": "application/json" })
          res.end("{}")
          return
        }
        res.writeHead(404).end()
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" })
        res.end((err as Error).message)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()))
  // Don't keep the event loop alive on this server alone.
  server.unref()
}

/* --------------------------------------------------------------------- */
/*  New-task dialog                                                       */
/* --------------------------------------------------------------------- */

type NewTaskInput = { repo: string; prompt: string }

/**
 * The new-task dialog. Per the Wave 3 G architectural pivot, we no
 * longer ask the user to type a separate title — Claude Code does
 * not store one (verified against the stream-json schema), so anything
 * we collect would be a parallel piece of metadata users would have
 * to maintain. Instead we ask for two fields:
 *
 *   1. `prompt` — the user's first message to Claude. The orchestrator
 *      derives a sidebar title from it via {@link deriveTitleFromPrompt}.
 *   2. `repo path` — defaults to `process.cwd()`.
 *
 * `tab` switches focus; `enter` on the last field commits.
 */
function NewTaskDialog(props: { onSubmit: (v: NewTaskInput) => void; onCancel: () => void; defaultRepo: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [field, setField] = createSignal<"prompt" | "repo">("prompt")
  const [prompt, setPrompt] = createSignal("")
  const [repo, setRepo] = createSignal(props.defaultRepo)

  function commit() {
    const p = prompt().trim()
    const r = repo().trim()
    if (!p || !r) return
    props.onSubmit({ prompt: p, repo: r })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        cmd: () => setField((f) => (f === "prompt" ? "repo" : "prompt")),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          New task
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={field() === "prompt" ? theme.accent : theme.textMuted}>first prompt</text>
        <input
          value={prompt()}
          placeholder="e.g. fix the login redirect bug"
          focused={field() === "prompt"}
          onInput={(v: string) => setPrompt(v)}
          onSubmit={() => {
            if (!prompt().trim()) return
            if (!repo().trim()) {
              setField("repo")
              return
            }
            commit()
          }}
        />
      </box>
      <box gap={0} paddingBottom={1}>
        <text fg={field() === "repo" ? theme.accent : theme.textMuted}>repo path</text>
        <input
          value={repo()}
          placeholder={props.defaultRepo}
          focused={field() === "repo"}
          onInput={(v: string) => setRepo(v)}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>tab to switch fields, enter to create, esc to cancel</text>
      </box>
    </box>
  )
}

function showNewTaskDialog(dialog: DialogContext, defaultRepo: string): Promise<NewTaskInput | undefined> {
  return new Promise<NewTaskInput | undefined>((resolve) => {
    dialog.replace(
      () => (
        <NewTaskDialog defaultRepo={defaultRepo} onSubmit={(v) => resolve(v)} onCancel={() => resolve(undefined)} />
      ),
      () => resolve(undefined),
    )
  })
}

/* --------------------------------------------------------------------- */
/*  Top-level Shell                                                       */
/* --------------------------------------------------------------------- */

export type AppDeps = {
  orchestrator: Orchestrator
}

/* --------------------------------------------------------------------- */
/*  PaneHeader — uniform CAPS-bold pane label (agent-deck-style chunking)  */
/* --------------------------------------------------------------------- */
function PaneHeader(props: { title: string; subtitle?: string; focused?: boolean }) {
  const { theme } = useTheme()
  // Focused panes get the primary accent color in their title; others
  // dim to textMuted so the eye locates the active pane immediately.
  const titleColor = () => (props.focused === false ? theme.textMuted : theme.primary)
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
        {props.title}
      </text>
      <Show when={props.subtitle}>
        <text fg={theme.textMuted} wrapMode="none">
          {props.subtitle}
        </text>
      </Show>
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Pane focus model                                                       */
/* --------------------------------------------------------------------- */
/**
 * Which pane currently owns the keyboard. Cycles via `tab` / `shift+tab`
 * (per `useKobeKeybindings`'s reservation in `keybindings.ts`); jumps via
 * `ctrl+1/2/3/4` for explicit pane targeting. Pane-local bindings gate
 * on their own `focused` accessor so j/k/etc. only fire on the active
 * pane.
 *
 * Order matters — `PANE_ORDER` defines the tab-cycle sequence and the
 * 1-4 numeric mapping. Sidebar is `1` (leftmost), terminal is `4`
 * (bottom-right).
 */
type PaneId = "sidebar" | "workspace" | "files" | "terminal"
const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

/**
 * `[Key]` chip — agent-deck-style key affordance. Key is BOLD inside a
 * tinted background block; label sits next to it in muted text.
 */
function Hotkey(props: { keys: string; label: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.keys}
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}

/**
 * Bottom status bar — agent-deck style. Left side: focused-pane label +
 * pane-local hotkeys. Right side: always-on global hotkeys.
 */
function StatusBar(props: { focusedPane: PaneId }) {
  const { theme } = useTheme()
  const sectionLabel = () => {
    switch (props.focusedPane) {
      case "sidebar":
        return "Tasks:"
      case "workspace":
        return "Chat:"
      case "files":
        return "Files:"
      case "terminal":
        return "Terminal:"
    }
  }
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      {/* Left: section label + pane-local hotkeys */}
      <box flexDirection="row" gap={2} flexShrink={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          {sectionLabel()}
        </text>
        <Switch>
          <Match when={props.focusedPane === "sidebar"}>
            <Hotkey keys="j/k" label="nav" />
            <Hotkey keys="enter" label="select" />
            <Hotkey keys="d" label="delete" />
          </Match>
          <Match when={props.focusedPane === "workspace"}>
            <Hotkey keys="enter" label="send" />
          </Match>
          <Match when={props.focusedPane === "files"}>
            <Hotkey keys="j/k" label="nav" />
            <Hotkey keys="enter" label="open" />
            <Hotkey keys="1/2/3" label="tab" />
            <Hotkey keys="r" label="refresh" />
          </Match>
          <Match when={props.focusedPane === "terminal"}>
            <Hotkey keys="ctrl+pgup" label="scroll" />
          </Match>
        </Switch>
      </box>
      {/* Right: global hotkeys (always available) */}
      <box flexDirection="row" gap={2} flexShrink={0}>
        <Hotkey keys="tab" label="cycle" />
        <Hotkey keys="ctrl+1234" label="focus" />
        <Hotkey keys="ctrl+n" label="new" />
        <Hotkey keys="?" label="help" />
        <Hotkey keys="q" label="quit" />
      </box>
    </box>
  )
}

function TopBar(props: { activeTitle?: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0} backgroundColor={theme.backgroundPanel}>
      <text fg={theme.primary} attributes={TextAttributes.BOLD}>
        kobe
      </text>
      <text fg={theme.textMuted}> — </text>
      <text fg={theme.text}>{props.activeTitle ?? "no task selected"}</text>
    </box>
  )
}

function Shell(props: AppDeps) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()
  const [selectedId, setSelectedId] = createSignal<string | null>(null)
  // Set by the new-task flow so the chat pane auto-submits the
  // prompt the user typed in the dialog. The chat clears it on
  // consumption to avoid re-submission on resubscribe.
  const [pendingPrompt, setPendingPrompt] = createSignal<{ taskId: string; prompt: string } | null>(null)

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
  const worktreePathAcc = createMemo<string | null>(() => activeTask()?.worktreePath ?? null)
  const taskIdNullAcc = createMemo<string | null>(() => selectedId())
  // Diff base — for v1, just compare against HEAD (working-tree changes).
  // Wave 4 polish makes this configurable per-task (e.g. branch fork point).
  const diffBaseAcc = createMemo<string | null>(() => (worktreePathAcc() ? "HEAD" : null))

  // FileTree → Preview wiring: capture Preview's imperative API once,
  // then route file-tree clicks/enters into Preview.open(). Plus the
  // outer center-column tab state below tracks which file tab is active.
  const [previewApi, setPreviewApi] = createSignal<PreviewApi | null>(null)

  /* ------------------------------------------------------------------- */
  /*  Pane focus — ctrl+1/2/3/4 jump, tab/shift+tab cycle                 */
  /* ------------------------------------------------------------------- */
  const [focusedPane, setFocusedPane] = createSignal<PaneId>("workspace")
  const isFocused = (id: PaneId) => () => focusedPane() === id

  function cycleFocus(delta: 1 | -1): void {
    const order = PANE_ORDER
    const idx = order.indexOf(focusedPane())
    const next = (idx + delta + order.length) % order.length
    setFocusedPane(order[next] as PaneId)
  }

  // Numeric jumps: ctrl+1..4 pick a pane explicitly. `ctrl` prefix avoids
  // collision with FileTree's plain 1/2/3 tabs (All/Changes/Checks) and
  // with composer typing.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "ctrl+1", cmd: () => setFocusedPane("sidebar") },
      { key: "ctrl+2", cmd: () => setFocusedPane("workspace") },
      { key: "ctrl+3", cmd: () => setFocusedPane("files") },
      { key: "ctrl+4", cmd: () => setFocusedPane("terminal") },
    ],
  }))

  // Tab / shift+tab cycle in the order defined by PANE_ORDER. The
  // existing kobe keymap reserved tab/shift+tab for exactly this.
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "tab", cmd: () => cycleFocus(1) },
      { key: "shift+tab", cmd: () => cycleFocus(-1) },
    ],
  }))

  /* ------------------------------------------------------------------- */
  /*  Center-column tab state — per-task                                  */
  /* ------------------------------------------------------------------- */
  // Per the resolved Wave-1 invariant ("each sidebar session = one
  // worktree") and Jackson's request: each task owns its own set of open
  // file tabs and which tab is active. Switching tasks restores the tab
  // strip exactly. Tabs are: a fixed `chat` plus zero-or-more file paths
  // (relative to the active task's worktree).
  type CenterTab = "chat" | { kind: "file"; path: string }
  type TaskCenterTabs = { open: readonly string[]; active: CenterTab }
  const EMPTY_TABS: TaskCenterTabs = { open: [], active: "chat" }
  const [tabsByTask, setTabsByTask] = createSignal(new Map<string, TaskCenterTabs>())

  const currentTabs = createMemo<TaskCenterTabs>(() => {
    const id = selectedId()
    if (!id) return EMPTY_TABS
    return tabsByTask().get(id) ?? EMPTY_TABS
  })
  const activeCenterTab = createMemo<CenterTab>(() => currentTabs().active)
  const openFileTabs = createMemo<readonly string[]>(() => currentTabs().open)
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

  function openFileInCenter(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({
      open: cur.open.includes(relPath) ? cur.open : [...cur.open, relPath],
      active: { kind: "file", path: relPath },
    }))
    previewApi()?.open(relPath)
    // Opening a file from the file tree pulls focus to the workspace
    // so the user can scroll/read with j/k without an extra ctrl+2.
    setFocusedPane("workspace")
  }

  function selectChatTab(): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({ ...cur, active: "chat" }))
    setFocusedPane("workspace")
  }

  function selectFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => ({ ...cur, active: { kind: "file", path: relPath } }))
    previewApi()?.open(relPath)
    setFocusedPane("workspace")
  }

  function closeFileTab(relPath: string): void {
    const id = selectedId()
    if (!id) return
    mutateTabs(id, (cur) => {
      const open = cur.open.filter((f) => f !== relPath)
      const wasActive = typeof cur.active === "object" && cur.active.path === relPath
      const fallback: CenterTab = open.length > 0 ? { kind: "file", path: open[open.length - 1] as string } : "chat"
      return { open, active: wasActive ? fallback : cur.active }
    })
    previewApi()?.close(relPath)
  }

  // Auto-select the first task when one is created and nothing is
  // selected yet. Makes the new-task → start-chatting flow one
  // keystroke shorter and matches what most multi-task TUIs do.
  createEffect(() => {
    const tasks = tasksAcc()
    if (selectedId()) return
    if (tasks.length > 0 && tasks[0]) setSelectedId(tasks[0].id)
  })

  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
  })

  // Shared "open new-task dialog and create" handler. Bound to two
  // keys with different `enabled` guards (see useBindings calls below).
  async function openNewTaskFlow(): Promise<void> {
    const result = await showNewTaskDialog(dialog, process.cwd())
    if (!result) return
    try {
      // Per the Wave 3 G pivot: we pass the prompt through and let
      // the orchestrator derive a sidebar title. The chat pane below
      // picks up `pendingPrompt` for the freshly-selected task and
      // submits it as the first turn — that way the new-task flow is
      // one keypress + the prompt the user already typed in the dialog.
      const created = await props.orchestrator.createTask({
        repo: result.repo,
        prompt: result.prompt,
      })
      // Stage the prompt so the Chat pane can submit it as soon as it
      // subscribes to the new task. The pending-prompt signal must be
      // set BEFORE we change the selected task so the same microtask
      // flush carries both updates.
      setPendingPrompt({ taskId: created.id, prompt: result.prompt })
      setSelectedId(created.id)
    } catch (err) {
      // Surface failure as stderr; we don't have a global banner yet,
      // and the chat pane may not be subscribed (no task selected).
      // eslint-disable-next-line no-console
      console.error("[kobe] createTask failed:", err)
    }
  }

  // `n` (bare letter) opens the new-task dialog when no task is
  // selected — once one is, the chat input claims focus and a bare
  // letter would type into the composer. The corresponding `ctrl+n`
  // binding below covers the "task already selected, want to add
  // another" case without colliding with input typing.
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !selectedId(),
    bindings: [
      {
        key: "n",
        cmd: () => {
          void openNewTaskFlow()
        },
      },
    ],
  }))

  // `ctrl+n` is always available (when no dialog is open). The chat
  // composer's input doesn't consume control chords, so this is the
  // safe path for "I'm in a chat but want to spawn a sibling task."
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+n",
        cmd: () => {
          void openNewTaskFlow()
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar activeTitle={activeTask()?.title} />
      <box flexDirection="row" flexGrow={1}>
        {/* Left: task sidebar (42 cells fixed). The sidebar's own
            "kobe v0.1.0" header serves as its pane identity. */}
        <Sidebar
          tasks={tasksAcc}
          onSelect={(id: string) => {
            setSelectedId(id)
            // Selecting a task usually means "I want to look at it" —
            // pull focus to workspace so the user can immediately type
            // / scroll without another ctrl+2.
            setFocusedPane("workspace")
          }}
          selectedId={selectedId}
          focused={isFocused("sidebar")}
        />
        {/* Center: tabbed (chat | <file>...) — primary interaction surface.
            `border={["left"]}` draws the agent-deck-style ┃ separator
            against the sidebar. Center gets twice the flex share of the
            right column so chat has visual weight. */}
        <box
          flexDirection="column"
          flexGrow={2}
          flexShrink={1}
          flexBasis={0}
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.border}
        >
          <PaneHeader
            title="WORKSPACE"
            subtitle={activeTask()?.title ?? "no task"}
            focused={focusedPane() === "workspace"}
          />
          <CenterTabStrip
            isChatActive={isChatTabActive}
            activeFile={activeFileTabPath}
            openFiles={openFileTabs}
            onSelectChat={selectChatTab}
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
              />
            </Show>
          </box>
        </box>
        {/* Right column: FILES top + TERMINAL bottom. Each gets a CAPS
            pane header. Vertical separator from center via `border=["left"]`,
            horizontal split between FILES and TERMINAL via a thin row.

            Width: flex-first per CLAUDE.md. The center workspace gets
            twice the share (flexGrow={2}) of this right column
            (flexGrow={1}); shrink-allowed so very-narrow terminals don't
            blow up. No magic-constant pixel widths here. */}
        <box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.border}
        >
          <box flexGrow={2} flexShrink={1} flexBasis={0} flexDirection="column">
            <PaneHeader title="FILES" focused={focusedPane() === "files"} />
            <box flexGrow={1}>
              <FileTree worktreePath={worktreePathAcc} onOpenFile={openFileInCenter} focused={isFocused("files")} />
            </box>
          </box>
          <box
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            flexDirection="column"
            border={["top"]}
            customBorderChars={HSplitBorder.customBorderChars}
            borderColor={theme.border}
          >
            <PaneHeader
              title="TERMINAL"
              subtitle={worktreePathAcc() ? worktreePathAcc()?.split("/").slice(-1)[0] : undefined}
              focused={focusedPane() === "terminal"}
            />
            <box flexGrow={1}>
              <Terminal cwd={worktreePathAcc} taskId={taskIdNullAcc} focused={isFocused("terminal")} />
            </box>
          </box>
        </box>
      </box>
      <StatusBar focusedPane={focusedPane()} />
    </box>
  )
}

/* --------------------------------------------------------------------- */
/*  Center column tab strip — chat + open files (per-task)                */
/* --------------------------------------------------------------------- */
function CenterTabStrip(props: {
  isChatActive: Accessor<boolean>
  activeFile: Accessor<string | null>
  openFiles: Accessor<readonly string[]>
  onSelectChat: () => void
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
}) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      paddingTop={0}
      paddingLeft={1}
      paddingRight={1}
      paddingBottom={1}
      backgroundColor={theme.backgroundPanel}
    >
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={props.isChatActive() ? theme.primary : theme.backgroundElement}
        onMouseUp={() => props.onSelectChat()}
      >
        <text
          fg={props.isChatActive() ? theme.selectedListItemText : theme.text}
          attributes={props.isChatActive() ? TextAttributes.BOLD : undefined}
        >
          chat
        </text>
      </box>
      <For each={props.openFiles()}>
        {(file) => {
          const isActive = () => props.activeFile() === file
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
              onMouseUp={() => props.onSelectFile(file)}
            >
              <text
                fg={isActive() ? theme.selectedListItemText : theme.text}
                attributes={isActive() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {basename(file)}
              </text>
              <text
                fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                onMouseUp={() => queueMicrotask(() => props.onCloseFile(file))}
              >
                x
              </text>
            </box>
          )
        }}
      </For>
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
              <Shell {...props} />
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
  const engine = await buildEngine()
  const homeDir = process.env.KOBE_HOME_DIR ?? homedir()
  const store = new TaskIndexStore({ homeDir })
  await store.load()
  const worktrees = new GitWorktreeManager()
  const orchestrator = new Orchestrator({ engine, store, worktrees })
  // Renderer-level background: transparent so the host terminal's
  // background (theme, image, transparency setting) shows through where
  // panes don't paint. opentui PR #824 / v0.1.89+ added this — earlier
  // versions composited transparent regions against opaque black.
  await render(() => <App orchestrator={orchestrator} />, { backgroundColor: "transparent" })
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
