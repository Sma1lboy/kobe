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
import { render, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import pkg from "../../package.json" with { type: "json" }
import { connectOrStartDaemon } from "../client/daemon-process.ts"
import { type KobeOrchestrator, RemoteOrchestrator } from "../client/remote-orchestrator.ts"
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { type ChatRunState, Orchestrator, chatRunStateKey } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import { getSavedRepos, removeSavedRepo } from "../state/repos.ts"
import type { AIEngine } from "../types/engine.ts"
import type { ChatTab, Task } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { CreatePRButton } from "./component/create-pr-button"
import { HelpDialog } from "./component/help-dialog"
import { NewTaskDialog, stripNewlines } from "./component/new-task-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { UpdateDialog } from "./component/update-dialog"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { KobeKeymap, useCtrlCArmed, useKobeKeybindings } from "./context/keybindings"
import { KVProvider, useKV } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, ThemeProvider, addTheme, useTheme } from "./context/theme"
import { loadUserThemes } from "./context/theme/loader"
import { useAppKeymap } from "./app-keymap"
import { Chat } from "./panes/chat/Chat"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { type DialogContext, DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

const DEFAULT_THEME = "claude"

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
  if (process.env.KOBE_TEST_ENGINE === "dev-fake") {
    // `bun run dev:test` mode — auto-replying fake so the dev TUI
    // exercises the chat round-trip without a real `claude` binary.
    // No HTTP scripter; canned replies live in DevAIEngine itself.
    const { DevAIEngine } = await import("../engine/dev-fake.ts")
    return new DevAIEngine()
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
        // Test affordance for W4.PR: trigger requestPR on the active
        // task. The Shell mounts a global function that knows the
        // active task; we call it from here. Returns 503 if the Shell
        // hasn't mounted yet (pre-render race window).
        if (req.url === "/pr" && req.method === "POST") {
          type PRTrigger = () => Promise<{ taskId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRequestPR?: PRTrigger }).__kobeTestRequestPR
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRequestPR not yet available")
            return
          }
          trigger()
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              res.writeHead(500, { "content-type": "text/plain" })
              res.end(err instanceof Error ? err.message : String(err))
            })
          return
        }
        // Test affordance for the user-input pause flows. Mirrors
        // /pr above: the Shell mounts __kobeTestRespondToInput which
        // knows the active task + its current pending-input bucket.
        // The test POSTs the body of an ApprovePlanResponse or
        // AskQuestionResponse and we route it through respondToInput
        // for the latest pending request. Returns 503 pre-mount, 409
        // when there's no pending request yet (the test should wait
        // for the picker to render), 200 with the resolved requestId
        // on success.
        if (req.url === "/respond" && req.method === "POST") {
          type RespondTrigger = (
            response: import("../types/engine.ts").UserInputResponse,
          ) => Promise<{ taskId: string; requestId: string; prompt: string }>
          const trigger = (globalThis as { __kobeTestRespondToInput?: RespondTrigger }).__kobeTestRespondToInput
          if (!trigger) {
            res.writeHead(503, { "content-type": "text/plain" })
            res.end("__kobeTestRespondToInput not yet available")
            return
          }
          let parsed: import("../types/engine.ts").UserInputResponse
          try {
            parsed = JSON.parse(body) as import("../types/engine.ts").UserInputResponse
          } catch (err) {
            res.writeHead(400, { "content-type": "text/plain" })
            res.end(`bad JSON: ${(err as Error).message}`)
            return
          }
          trigger(parsed)
            .then((info) => {
              res.writeHead(200, { "content-type": "application/json" })
              res.end(JSON.stringify(info))
            })
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              // No-pending-request is a 409 so the test can distinguish
              // "you raced" from "the engine actually failed."
              const code = msg.includes("no pending input") ? 409 : 500
              res.writeHead(code, { "content-type": "text/plain" })
              res.end(msg)
            })
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

// New-task dialog lives in `./component/new-task-dialog/` — see that
// module for the state machine (state.ts), the JSX shell (dialog.tsx),
// and the `NewTaskDialog.show(...)` entry point. Imported above.
//
// `stripNewlines` is shared from the same module because the
// rename-task dialog below sanitizes its input the same way (opentui's
// `<input>` quirk that inserts a literal `\n` on Enter).

/* --------------------------------------------------------------------- */
/*  Rename-task dialog                                                    */
/* --------------------------------------------------------------------- */

/**
 * Single-field rename dialog. Sidebar `r` opens this for the cursor task
 * with the current title pre-filled in the input so the user can edit
 * in place. Enter commits, esc cancels (handled by the dialog stack).
 *
 * Trim + empty-string guard: `enter` on an empty/whitespace-only value
 * is a no-op (we don't dismiss, so the user notices nothing happened
 * and can either type something or hit esc). The orchestrator's
 * setTitle defends in depth.
 */
function RenameTaskDialog(props: {
  currentTitle: string
  dialogTitle?: string
  onSubmit: (title: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [title, setTitle] = createSignal(props.currentTitle)

  function commit() {
    const t = title().trim()
    if (!t) return
    props.onSubmit(t)
    dialog.clear()
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.dialogTitle ?? "Rename task"}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={0}>
        <text fg={theme.accent}>title</text>
        <input
          value={title()}
          placeholder={props.currentTitle}
          focused={true}
          onInput={(v: string) => setTitle(stripNewlines(v))}
          onSubmit={() => commit()}
        />
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>enter rename · esc cancel</text>
      </box>
    </box>
  )
}

function showRenameTaskDialog(
  dialog: DialogContext,
  currentTitle: string,
  opts: { dialogTitle?: string } = {},
): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    dialog.replace(
      () => (
        <RenameTaskDialog
          currentTitle={currentTitle}
          dialogTitle={opts.dialogTitle}
          onSubmit={(v) => resolve(v)}
          onCancel={() => resolve(undefined)}
        />
      ),
      () => resolve(undefined),
    )
  })
}

/* --------------------------------------------------------------------- */
/*  Top-level Shell                                                       */
/* --------------------------------------------------------------------- */

export type AppDeps = {
  orchestrator: KobeOrchestrator
}

/* --------------------------------------------------------------------- */
/*  PaneHeader — uniform CAPS-bold pane label (agent-deck-style chunking)  */
/* --------------------------------------------------------------------- */
function PaneHeader(props: {
  title: string
  subtitle?: string
  /** Far-right hint (e.g. context %). Shown after `subtitle` when both exist. */
  asideRight?: string
  focused?: boolean
  ordinal?: string | number
}) {
  const { theme } = useTheme()
  // Focused panes paint in `theme.focusAccent` — a user-controllable
  // slot (Settings → General → Focus accent) that resolves to one of
  // primary / success / info. Default is primary (terracotta under
  // Claude's palette), which doubles as the brand hue. The leading
  // `▌` block character is the visibility hammer the prior bold-only
  // title was missing — it attaches the focus signal to the title
  // visually so the user's eye doesn't scan the whole screen to pick
  // up the active pane.
  const focused = () => props.focused !== false
  const titleColor = () => (focused() ? theme.focusAccent : theme.textMuted)
  const hasRight = () => Boolean(props.subtitle) || Boolean(props.asideRight)
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      flexShrink={0}
      // paddingTop=1 mirrors the Sidebar pane's outer paddingTop so
      // all four pane titles sit at the same baseline row. The
      // ordinal sits flush at the left edge (no ▌ marker, no extra
      // gap) — earlier the `▌ <ord> <title>` shape with gap=1
      // produced two cells of whitespace before the digit and the
      // four markers visually drifted out of alignment by a column.
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" gap={1} flexShrink={1}>
        {/* Ordinal flush left — plain BOLD; the focus-tracking color
            (focusAccent vs textMuted) is what flags this digit as the
            ctrl+N chord target. The underline variant felt visually
            noisy at title-row scale. */}
        <Show when={props.ordinal !== undefined}>
          <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
            {props.ordinal}
          </text>
        </Show>
        <text fg={titleColor()} attributes={TextAttributes.BOLD} wrapMode="none">
          {props.title}
        </text>
      </box>
      <Show when={hasRight()}>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.subtitle}>
            <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
              {props.subtitle}
            </text>
          </Show>
          <Show when={props.asideRight}>
            <text fg={theme.textMuted} wrapMode="none">
              {props.asideRight}
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

/**
 * `[Key]` chip — agent-deck-style key affordance. The key is wrapped in
 * literal brackets in BOLD accent color; label follows in muted text.
 * No filled background → terminal shows through.
 */
function Hotkey(props: { keys: string; label: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme.accent} attributes={TextAttributes.BOLD} wrapMode="none">
        [{props.keys}]
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {props.label}
      </text>
    </box>
  )
}

/**
 * Bottom status bar — agent-deck style. Left side: focused-pane label +
 * pane-local hotkeys. Right side: always-on global hotkeys. Reads the
 * focused pane from context so the parent doesn't need to thread it.
 */
function StatusBar() {
  const { theme } = useTheme()
  const focus = useFocus()
  const ctrlCArmed = useCtrlCArmed()
  const sectionLabel = () => {
    switch (focus.focused()) {
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
  // Pane-local hints come from KobeKeymap by scope; only rows with a
  // non-pinned `hint` and a `scope` matching the focused pane and a
  // workspace-detach exception (esc detach is global but we want it to
  // surface only while workspace is focused — sidebar already IS sidebar,
  // files/terminal use it more rarely). The condition is simple: `hint
  // && !pin && (scope === focused || (id === "focus.detach" && focused
  // === "workspace"))`.
  const leftHints = () =>
    KobeKeymap.filter((b) => {
      if (!b.hint || b.hint.pin) return false
      if (b.scope === focus.focused()) return true
      if (b.id === "focus.detach" && focus.focused() === "workspace") return true
      return false
    })
  // Right column = anything pinned right; order preserved from KobeKeymap.
  const rightHints = KobeKeymap.filter((b) => b.hint?.pin === "right")

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Left: section label + pane-local hotkeys (driven by KobeKeymap) */}
      <box flexDirection="row" gap={2} flexShrink={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          {sectionLabel()}
        </text>
        <For each={leftHints()}>{(b) => <Hotkey keys={b.hint!.keys} label={b.hint!.label} />}</For>
      </box>
      {/* Right: global hotkeys (always available). Driven by KobeKeymap's
          `pin: "right"` rows. When ctrl+c is armed for double-tap quit,
          a warning chip is added so the user knows the next ctrl+c
          will exit. (The real quit chord — sidebar `q` — surfaces in
          the LEFT column when sidebar is focused, so the right column
          is just for cross-pane reminders now.) */}
      <box flexDirection="row" gap={2} flexShrink={0}>
        <For each={rightHints}>{(b) => <Hotkey keys={b.hint!.keys} label={b.hint!.label} />}</For>
        <Show when={ctrlCArmed()}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            Press Ctrl+C again to exit
          </text>
        </Show>
      </box>
    </box>
  )
}

function TopBar(props: {
  orchestrator: KobeOrchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  const dialog = useDialog()
  // Three columns of equal flex so the center sits at the geometric
  // midpoint regardless of the left brand width or the right PR button
  // width. Left = brand+version. Center = active task's branch (no
  // "Repo <name>" prefix — kobe spans many repos so a single repo
  // label in the topbar is misleading; the active branch alone is the
  // useful per-task signal). Right = PR action.
  return (
    <box flexDirection="row" paddingLeft={2} paddingRight={2} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="flex-start">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          KobeCode
        </text>
        <text fg={theme.textMuted}>v{pkg.version}</text>
        {/* Update chip — clickable: opens the UpdateDialog with the
            install command and the GitHub release notes for what's new.
            Only renders when the npm-registry check found a newer
            published version. Informational only — no auto-update.
            Suppressed entirely in dev mode (KOBE_DEV=1, set by
            `bun run dev`). */}
        <Show when={props.updateInfo()?.hasUpdate}>
          <text
            fg={theme.warning}
            attributes={TextAttributes.BOLD}
            onMouseUp={() => {
              const info = props.updateInfo()
              if (info) UpdateDialog.show(dialog, info)
            }}
          >
            ↑ v{props.updateInfo()?.latest} available
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="center">
        <Show when={props.activeTask() !== undefined}>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
            {props.activeTask()?.branch}
          </text>
        </Show>
      </box>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} justifyContent="flex-end">
        <CreatePRButton orchestrator={props.orchestrator} activeTask={props.activeTask} />
      </box>
    </box>
  )
}

function Shell(props: AppDeps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const dialog = useDialog()
  const kv = useKV()

  // Theme persistence — on mount, hydrate from KV (validates the
  // stored name against the bundled list to drop stale entries from a
  // theme that was renamed). On every theme switch, persist the new
  // name. Same shape for the orthogonal `transparentBackground` toggle.
  // ThemeProvider is mounted OUTER of KVProvider, so we hydrate here
  // rather than inside ThemeProvider's init.
  const persistedTheme = kv.get("activeTheme")
  if (typeof persistedTheme === "string" && themeCtx.has(persistedTheme)) {
    themeCtx.set(persistedTheme)
  }
  const persistedTransparent = kv.get("transparentBackground")
  if (typeof persistedTransparent === "boolean") {
    themeCtx.setTransparentBackground(persistedTransparent)
  }
  // Focus-accent slot — same hydrate-then-mirror pattern. Validates
  // against the known slot list so a stale value from an older kobe
  // (or a hand-edited state.json) drops cleanly to default rather than
  // poisoning the proxy.
  const persistedFocusAccent = kv.get("focusAccent")
  if (
    typeof persistedFocusAccent === "string" &&
    (FOCUS_ACCENT_SLOTS as ReadonlyArray<string>).includes(persistedFocusAccent)
  ) {
    themeCtx.setFocusAccent(persistedFocusAccent as FocusAccentSlot)
  }
  createEffect(() => {
    kv.set("activeTheme", themeCtx.selected)
  })
  createEffect(() => {
    kv.set("transparentBackground", themeCtx.transparentBackground)
  })
  createEffect(() => {
    kv.set("focusAccent", themeCtx.focusAccent)
  })

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
  /*  Pane resize — three <ResizableEdge /> splitters                     */
  /* ------------------------------------------------------------------- */
  // Sidebar default 42 (the long-standing "history rail" convention from
  // opencode/agent-deck). Workspace and files are seeded from the
  // pre-resize 2:1 flex ratio so the layout looks the same on first paint
  // and starts diverging only when the user drags. We keep the sizes as
  // plain numbers (not optional) so the layout is always controlled —
  // simpler than juggling a "have they dragged yet" flag, at the cost of
  // not auto-rebalancing on terminal resize (just clamps to fit).
  //
  // Mins: sidebar 20 (status badge + first 8-10 chars of a title still
  // legible); workspace 30 (chat needs room to breathe); right column min
  // is implicit via "max workspace = total - sidebar - 1 splitter - min
  // right". Files min 5 / terminal min 5 (header + ~3 rows of content).
  const MIN_SIDEBAR_WIDTH = 20
  const MIN_WORKSPACE_WIDTH = 30
  const MIN_RIGHT_COLUMN_WIDTH = 30
  const MIN_FILES_HEIGHT = 5
  const MIN_TERMINAL_HEIGHT = 5
  const dims = useTerminalDimensions()
  // Hydrate the resize-pane sizes from KV when present so a kobe restart
  // lands on the layout the user dragged into last session. Defaults are
  // computed off the live terminal dims when KV has nothing — first
  // launch on a small terminal still gets a sensible starting point.
  // We persist via createEffect below, debounced by the natural drag
  // throttle (mouse-move events update the signal; KV.set is cheap).
  const persistedSidebar = (() => {
    const v = kv.get("paneSidebarWidth")
    return typeof v === "number" && v >= MIN_SIDEBAR_WIDTH ? v : null
  })()
  const persistedWorkspace = (() => {
    const v = kv.get("paneWorkspaceWidth")
    return typeof v === "number" && v >= MIN_WORKSPACE_WIDTH ? v : null
  })()
  const persistedFiles = (() => {
    const v = kv.get("paneFilesHeight")
    return typeof v === "number" && v >= MIN_FILES_HEIGHT ? v : null
  })()
  const initialDims = dims()
  const [sidebarWidth, setSidebarWidth] = createSignal(persistedSidebar ?? 42)
  // Initial workspace / files seeds: computed once from the terminal
  // dims at mount when KV has nothing. These are deliberately not
  // reactive to terminal resizes — the user's last drag wins.
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    persistedWorkspace ?? Math.max(MIN_WORKSPACE_WIDTH, Math.floor((initialDims.width - 42 - 1) * (2 / 3))),
  )
  const initialRightColumnHeight = Math.max(20, initialDims.height - 2 - 1)
  const [filesHeight, setFilesHeight] = createSignal(
    persistedFiles ?? Math.max(MIN_FILES_HEIGHT, Math.floor(initialRightColumnHeight * (2 / 3))),
  )

  // Persist on every resize. The signals only change during a drag (or
  // a clamp on terminal resize), so this fires per drag-frame at most —
  // KV.set is in-memory until the provider's debounced write hits disk.
  createEffect(() => {
    kv.set("paneSidebarWidth", sidebarWidth())
  })
  createEffect(() => {
    kv.set("paneWorkspaceWidth", workspaceWidth())
  })
  createEffect(() => {
    kv.set("paneFilesHeight", filesHeight())
  })

  const clampSidebar = (w: number) => {
    const max = Math.max(
      MIN_SIDEBAR_WIDTH,
      dims().width - workspaceWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, w))
  }
  const clampWorkspace = (w: number) => {
    const max = Math.max(
      MIN_WORKSPACE_WIDTH,
      dims().width - sidebarWidth() - MIN_RIGHT_COLUMN_WIDTH - 2 /* two splitters */,
    )
    return Math.min(max, Math.max(MIN_WORKSPACE_WIDTH, w))
  }
  const clampFiles = (h: number) => {
    // Files height max = right column height - terminal min - 1 (splitter).
    // We approximate right column height as `dims.height - topbar - statusbar`.
    const rightColH = Math.max(MIN_FILES_HEIGHT + MIN_TERMINAL_HEIGHT + 1, dims().height - 2)
    const max = Math.max(MIN_FILES_HEIGHT, rightColH - MIN_TERMINAL_HEIGHT - 1)
    return Math.min(max, Math.max(MIN_FILES_HEIGHT, h))
  }

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

  // Keyboard resize for the focused pane — fallback when mouse drag
  // misfires on the splitter. ctrl+= / ctrl++ grows, ctrl+- / ctrl+_
  // shrinks. The keymap normalizer (lib/keymap.tsx) drops the shift
  // modifier on single-char names since shift+= already produces `+`,
  // so we register both `+` and `=` on the grow side and both `-` and
  // `_` on the shrink side to match whatever shape the terminal sends.
  // Terminal pane grows by SHRINKING filesHeight (its height is the
  // residual under filesHeight in the right column); the rest of the
  // panes grow their own width/height directly.
  const RESIZE_STEP = 2
  function nudgeFocusedPane(delta: number): void {
    switch (focusedPane()) {
      case "sidebar":
        setSidebarWidth(clampSidebar(sidebarWidth() + delta))
        return
      case "workspace":
        setWorkspaceWidth(clampWorkspace(workspaceWidth() + delta))
        return
      case "files":
        setFilesHeight(clampFiles(filesHeight() + delta))
        return
      case "terminal":
        // Inverse: growing the terminal = shrinking files above it.
        setFilesHeight(clampFiles(filesHeight() - delta))
        return
    }
  }
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
    const next = await showRenameTaskDialog(dialog, task.title)
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
    const next = await showRenameTaskDialog(dialog, current, { dialogTitle: "Rename chat tab" })
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

/* --------------------------------------------------------------------- */
/*  Center column tab strip — chat + open files (per-task)                */
/* --------------------------------------------------------------------- */
function CenterTabStrip(props: {
  isChatActive: Accessor<boolean>
  /**
   * The currently-open file path (workspace shows at most one file
   * tab per task — KOB-20). `null` when no file is open. Selecting a
   * different file in the file tree replaces this in place.
   */
  activeFile: Accessor<string | null>
  /**
   * Per-task chat tabs. With multitab, "chat" is no longer a single
   * entry — each tab gets its own chip in this strip alongside the
   * single file chip, so the user has one unified tab navigation.
   * Falls back to a single static "chat" chip when the task has no
   * tabs yet (e.g. before the first runTask).
   */
  chatTabs: Accessor<readonly ChatTab[]>
  activeChatTabId: Accessor<string | null>
  /**
   * The currently-selected task id (or undefined when nothing is
   * selected). Combined with each chat tab's id to look up the live
   * engine state in {@link chatRunState}. When undefined, every chip
   * resolves to idle — there's no task to attribute the run-state to.
   */
  activeTaskId: Accessor<string | undefined>
  /**
   * Per-chat-tab live engine state, keyed by `${taskId}:${tabId}`
   * (compose via {@link chatRunStateKey}). Drives the leading status
   * dot on each chat-tab chip — green when streaming, yellow when the
   * tab is paused on `AskUserQuestion` / `ExitPlanMode`, no dot when
   * idle. Absence of an entry == idle.
   */
  chatRunState: Accessor<ReadonlyMap<string, ChatRunState>>
  onSelectChat: () => void
  onSelectChatTab: (tabId: string) => void
  onSelectFile: (path: string) => void
  onCloseFile: (path: string) => void
}) {
  const { theme } = useTheme()
  /**
   * Display label for a chat tab — falls back to `chat N` where N is
   * the tab's sticky `seq`, NOT its current array index. Closing a
   * middle tab must not renumber surviving tabs.
   */
  const chatTabLabel = (tab: ChatTab) => (tab.title && tab.title.length > 0 ? tab.title : `chat ${tab.seq}`)
  return (
    <box
      flexDirection="row"
      gap={1}
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.backgroundPanel}
    >
      <Show
        when={props.chatTabs().length > 0}
        fallback={
          // Pre-runTask state — task has no tabs yet (or no task at
          // all). Render the static "chat" chip so the strip isn't
          // empty and the user can still see they're on chat.
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
        }
      >
        <For each={props.chatTabs()}>
          {(tab, i) => {
            // A chat tab chip is "active" only when the workspace is on
            // chat AND this is the active chat tab. When chat is open
            // but a different tab is selected, we still want it to look
            // distinct from "chat is hidden behind a file tab" — render
            // the active chat-tab in primary, the inactive chat-tabs in
            // a softer style, and all of them dim when chat isn't the
            // workspace tab at all.
            const isPrimary = () => props.isChatActive() && props.activeChatTabId() === tab.id
            const isVisibleButOther = () => props.isChatActive() && !isPrimary()
            // Live engine state for this chat tab. Resolved through the
            // composite `${taskId}:${tabId}` key so a multi-tab task
            // can show, say, yellow on the asking tab and green on a
            // streaming sibling at the same time.
            const runState = (): ChatRunState | undefined => {
              const taskId = props.activeTaskId()
              if (!taskId) return undefined
              return props.chatRunState().get(chatRunStateKey(taskId, tab.id))
            }
            const dotGlyph = () => {
              const s = runState()
              return s === "running" || s === "awaiting_input" ? "●" : ""
            }
            // The dot's color is the run-state signal — never the
            // chip's selection color. Earlier we tinted it
            // `selectedListItemText` when the chip was primary so it
            // matched the chip text, but that swallowed the live
            // green/yellow signal exactly when Jackson was looking at
            // the active tab and most needed to see whether it was
            // running. The status dot's job overrides the chip's
            // emphasis; green/yellow stay legible on the primary
            // background.
            const dotColor = () => {
              const s = runState()
              if (s === "awaiting_input") return theme.warning
              if (s === "running") return theme.success
              return theme.textMuted
            }
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isPrimary() ? theme.primary : theme.backgroundElement}
                onMouseUp={() => {
                  if (!props.isChatActive()) props.onSelectChat()
                  props.onSelectChatTab(tab.id)
                }}
              >
                <Show when={dotGlyph().length > 0}>
                  <text fg={dotColor()} wrapMode="none">
                    {dotGlyph()}
                  </text>
                </Show>
                {/* No leading ordinal — chat tabs cycle via ctrl+[/]
                    rather than ctrl+N, so a digit prefix would
                    misadvertise the chord. */}
                <text
                  fg={isPrimary() ? theme.selectedListItemText : isVisibleButOther() ? theme.text : theme.textMuted}
                  attributes={isPrimary() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                >
                  {chatTabLabel(tab)}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
      <Show when={props.activeFile()}>
        {(file) => {
          // Single file chip — present iff a file is open. Always rendered
          // as primary while the workspace is on file mode (it's the only
          // file chip, so it's always the active one), muted when chat is
          // showing instead.
          const isActive = () => !props.isChatActive()
          return (
            <box
              flexDirection="row"
              gap={1}
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isActive() ? theme.primary : theme.backgroundElement}
              onMouseUp={() => props.onSelectFile(file())}
            >
              <text
                fg={isActive() ? theme.selectedListItemText : theme.text}
                attributes={isActive() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
              >
                {basename(file())}
              </text>
              <text
                fg={isActive() ? theme.selectedListItemText : theme.textMuted}
                onMouseUp={() => queueMicrotask(() => props.onCloseFile(file()))}
              >
                x
              </text>
            </box>
          )
        }}
      </Show>
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
