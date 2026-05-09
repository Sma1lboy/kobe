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
import { render, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, For, Match, Show, Switch, createEffect, createMemo, createSignal, onMount } from "solid-js"
import pkg from "../../package.json" with { type: "json" }
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"
import type { Task } from "../types/task.ts"
import { type UpdateInfo, checkLatestVersion } from "../version.ts"
import { CreatePRButton } from "./component/create-pr-button"
import { HelpDialog } from "./component/help-dialog"
import { ResizableEdge } from "./component/resizable-edge"
import { CommandPaletteProvider } from "./context/command-palette"
import { FocusProvider, type PaneId, useFocus } from "./context/focus"
import { useCtrlCArmed, useKobeKeybindings } from "./context/keybindings"
import { KVProvider, useKV } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { useBindings } from "./lib/keymap"
import { Chat } from "./panes/chat/Chat"
import { FileTree } from "./panes/filetree"
import { Preview, type PreviewApi } from "./panes/preview"
import { Sidebar } from "./panes/sidebar/Sidebar"
import { Terminal } from "./panes/terminal"
import { type DialogContext, DialogProvider, useDialog } from "./ui/dialog"
import { DialogConfirm } from "./ui/dialog-confirm"

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

type NewTaskInput = { repo: string; prompt: string; baseRef: string }

/** Default base ref when the user leaves the field blank. */
const DEFAULT_BASE_REF = "main"

/**
 * List local branches in the given repo, sorted with the default branch
 * first when present. Synchronous — repo enumeration is a one-shot call
 * driven by the dialog's repo-field changes, so paying for an async
 * boundary buys nothing. Returns [] on any error so the picker just
 * silently degrades to the free-text input.
 */
function listLocalBranches(repo: string): string[] {
  if (!repo) return []
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const out = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], {
      cwd: repo,
      encoding: "utf-8",
      timeout: 2000,
    })
    if (out.status !== 0) return []
    return (out.stdout as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .sort((a, b) => {
        // Default branches first.
        const score = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : n === "develop" ? 2 : 3)
        const sa = score(a)
        const sb = score(b)
        if (sa !== sb) return sa - sb
        return a.localeCompare(b)
      })
  } catch {
    return []
  }
}

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
  const [field, setField] = createSignal<"prompt" | "repo" | "baseRef">("prompt")
  const [prompt, setPrompt] = createSignal("")
  const [repo, setRepo] = createSignal(props.defaultRepo)
  const [baseRef, setBaseRef] = createSignal(DEFAULT_BASE_REF)

  // Branch picker — refreshed whenever the repo path changes. The
  // baseRef field still accepts free text (so tags / commit SHAs / refs
  // not in the local branch list still work), but typing is augmented
  // with up/down navigation over the discovered branches: highlights
  // the cursor row and pre-fills the input as the user moves.
  const branches = createMemo<readonly string[]>(() => listLocalBranches(repo().trim()))
  const [branchCursor, setBranchCursor] = createSignal(0)

  // Reset the cursor whenever the branch list changes (repo edit) so we
  // don't index off the end after a smaller-list refresh.
  createEffect(() => {
    void branches()
    setBranchCursor(0)
  })

  function commit() {
    const p = prompt().trim()
    const r = repo().trim()
    if (!p || !r) return
    const b = baseRef().trim() || DEFAULT_BASE_REF
    props.onSubmit({ prompt: p, repo: r, baseRef: b })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        // 3-way cycle: prompt → repo → baseRef → prompt. Mirrors the
        // visual top-to-bottom field order so muscle memory works.
        key: "tab",
        cmd: () =>
          setField((f) => {
            if (f === "prompt") return "repo"
            if (f === "repo") return "baseRef"
            return "prompt"
          }),
      },
      // Branch list nav — only fires when on the baseRef field AND
      // there's at least one branch to navigate. up/down move the
      // cursor; pressing them also pre-fills the input with the
      // highlighted branch so `enter` commits with that value.
      {
        key: "up",
        cmd: () => {
          if (field() !== "baseRef") return
          const list = branches()
          if (list.length === 0) return
          const next = Math.max(0, branchCursor() - 1)
          setBranchCursor(next)
          const sel = list[next]
          if (sel) setBaseRef(sel)
        },
      },
      {
        key: "down",
        cmd: () => {
          if (field() !== "baseRef") return
          const list = branches()
          if (list.length === 0) return
          const next = Math.min(list.length - 1, branchCursor() + 1)
          setBranchCursor(next)
          const sel = list[next]
          if (sel) setBaseRef(sel)
        },
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
      <box gap={0}>
        <text fg={field() === "repo" ? theme.accent : theme.textMuted}>repo path</text>
        <input
          value={repo()}
          placeholder={props.defaultRepo}
          focused={field() === "repo"}
          onInput={(v: string) => setRepo(v)}
          onSubmit={() => {
            if (!prompt().trim()) {
              setField("prompt")
              return
            }
            if (!repo().trim()) return
            commit()
          }}
        />
      </box>
      <box gap={0}>
        <text fg={field() === "baseRef" ? theme.accent : theme.textMuted}>from branch</text>
        <input
          value={baseRef()}
          placeholder={DEFAULT_BASE_REF}
          focused={field() === "baseRef"}
          onInput={(v: string) => setBaseRef(v)}
          onSubmit={() => commit()}
        />
      </box>
      {/* Branch picker: rendered when on baseRef field and the repo
          actually has discoverable local branches. Up/down navigate
          (handler in useBindings above pre-fills the input as cursor
          moves); click selects + commits. */}
      <Show when={field() === "baseRef" && branches().length > 0}>
        <box gap={0} paddingLeft={2} paddingBottom={1}>
          <For each={branches()}>
            {(name, i) => {
              const isCursor = () => i() === branchCursor()
              const isSelected = () => baseRef().trim() === name
              return (
                <text
                  fg={isCursor() ? theme.primary : isSelected() ? theme.accent : theme.textMuted}
                  attributes={isCursor() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => {
                    setBaseRef(name)
                    setBranchCursor(i())
                    commit()
                  }}
                >
                  {isCursor() ? "▸ " : "  "}
                  {name}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>tab fields · ↑↓ pick branch · enter create · esc cancel</text>
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
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
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
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Left: section label + pane-local hotkeys */}
      <box flexDirection="row" gap={2} flexShrink={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          {sectionLabel()}
        </text>
        <Switch>
          <Match when={focus.focused() === "sidebar"}>
            <Hotkey keys="j/k" label="nav" />
            <Hotkey keys="enter" label="select" />
            <Hotkey keys="a" label="archive" />
            <Hotkey keys="[/]" label="view" />
            <Hotkey keys="d" label="delete" />
          </Match>
          <Match when={focus.focused() === "workspace"}>
            <Hotkey keys="enter" label="send" />
            <Hotkey keys="ctrl+q" label="back to sidebar" />
          </Match>
          <Match when={focus.focused() === "files"}>
            <Hotkey keys="j/k" label="nav" />
            <Hotkey keys="enter" label="open" />
            <Hotkey keys="1/2/3" label="tab" />
            <Hotkey keys="r" label="refresh" />
          </Match>
          <Match when={focus.focused() === "terminal"}>
            <Hotkey keys="ctrl+pgup" label="scroll" />
          </Match>
        </Switch>
      </box>
      {/* Right: global hotkeys (always available). When ctrl+c is armed
          for double-tap quit, the `q quit` chip is replaced by a warning
          hint so the user knows the next ctrl+c will exit. */}
      <box flexDirection="row" gap={2} flexShrink={0}>
        <Hotkey keys="tab" label="cycle" />
        <Hotkey keys="ctrl+1234" label="focus" />
        <Hotkey keys="ctrl+n" label="new" />
        <Hotkey keys="?" label="help" />
        <Show when={ctrlCArmed()} fallback={<Hotkey keys="q" label="quit" />}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD} wrapMode="none">
            Press Ctrl+C again to exit
          </text>
        </Show>
      </box>
    </box>
  )
}

function TopBar(props: {
  orchestrator: Orchestrator
  activeTask: Accessor<Task | undefined>
  updateInfo: Accessor<UpdateInfo | null>
}) {
  const { theme } = useTheme()
  // Three columns of equal flex so the center sits at the geometric
  // midpoint regardless of the left brand width or the right PR button
  // width. Left = brand+version. Center = active task's branch (no
  // "Repo <name>" prefix — kobe spans many repos so a single repo
  // label in the topbar is misleading; the active branch alone is the
  // useful per-task signal). Right = PR action.
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="row" flexGrow={1} flexShrink={1} flexBasis={0} gap={1} justifyContent="flex-start">
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          KobeCode
        </text>
        <text fg={theme.textMuted}>v{pkg.version}</text>
        {/* Update chip — only renders when the npm-registry check found
            a newer published version. Informational only; the user is
            expected to run `bun install -g @sma1lboy/kobe@latest`
            (or the equivalent) themselves. The fetch is async and
            cached, so this stays empty on cold boots without network. */}
        <Show when={props.updateInfo()?.hasUpdate}>
          <text fg={theme.warning} attributes={TextAttributes.BOLD}>
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
  const { theme } = useTheme()
  const dialog = useDialog()
  const kv = useKV()

  const tasksAcc: Accessor<ReturnType<typeof props.orchestrator.listTasks>> = props.orchestrator.tasksSignal()
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
  const [sidebarWidth, setSidebarWidth] = createSignal(42)
  // Initial workspace / files seeds: computed once from the terminal
  // dims at mount. These are deliberately not reactive to terminal
  // resizes — the user's last drag wins. Negative or undersized
  // terminals just get clamped on first paint.
  const initialDims = dims()
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    Math.max(MIN_WORKSPACE_WIDTH, Math.floor((initialDims.width - 42 - 1) * (2 / 3))),
  )
  // Right column inner height ≈ terminal - topbar - statusbar - 2 borders.
  // Topbar/statusbar are 1 row each; HSplitBorder consumes 1 row.
  const initialRightColumnHeight = Math.max(20, initialDims.height - 2 - 1)
  const [filesHeight, setFilesHeight] = createSignal(
    Math.max(MIN_FILES_HEIGHT, Math.floor(initialRightColumnHeight * (2 / 3))),
  )

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
  // Pane-bindings-active accessor: true only when (a) the pane is the
  // focused one AND (b) no dialog is open. The dialog gate prevents
  // sidebar/files/terminal bindings from firing while the user is
  // typing into a dialog input — `d` typed into a path field would
  // otherwise trigger the sidebar's delete-task confirmation.
  const isFocused = (pane: PaneId): Accessor<boolean> => {
    const baseAcc = focus.is(pane)
    return () => baseAcc() && dialog.stack.length === 0
  }

  // Numeric jumps: ctrl+1..4 pick a pane explicitly. `ctrl` prefix avoids
  // collision with FileTree's plain 1/2/3 tabs (All/Changes/Checks) and
  // with composer typing. Always-on (modifier keys don't go to inputs).
  useBindings(() => ({
    enabled: dialog.stack.length === 0,
    bindings: [
      { key: "ctrl+1", cmd: () => setFocusedPane("sidebar") },
      { key: "ctrl+2", cmd: () => setFocusedPane("workspace") },
      { key: "ctrl+3", cmd: () => setFocusedPane("files") },
      { key: "ctrl+4", cmd: () => setFocusedPane("terminal") },
      // ctrl+q "detach": from any pane, jump back to the sidebar without
      // pausing the chat. The orchestrator's pump runs independently of
      // focus, so the engine keeps streaming while the user navigates
      // tasks. Wave 4.5 — Jackson's request for "detach but keep
      // working" semantics from inside the composer.
      { key: "ctrl+q", cmd: () => setFocusedPane("sidebar") },
    ],
  }))

  // Tab / shift+tab cycle. Disabled when workspace is focused — opentui
  // inputs consume tab and we don't want focus-cycle racing with the
  // composer's own tab handling (e.g. dialog field switches).
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && focusedPane() !== "workspace",
    bindings: [
      { key: "tab", cmd: () => focus.cycle(1) },
      { key: "shift+tab", cmd: () => focus.cycle(-1) },
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
  // Hydrate from KV. Stored as a plain object keyed by taskId because Maps
  // aren't JSON-serializable. Tasks deleted between runs leak entries into
  // the file; harmless and pruned the next time we persist after a real
  // selection change. (Could prune on hydrate if it ever matters.)
  const persistedTabs = kv.get("centerTabsByTask") as Record<string, TaskCenterTabs> | undefined
  const [tabsByTask, setTabsByTask] = createSignal(
    new Map<string, TaskCenterTabs>(persistedTabs ? Object.entries(persistedTabs) : []),
  )

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

  useKobeKeybindings({
    onShowHelp: () => HelpDialog.show(dialog),
    // When the chat composer is the active input (workspace focused),
    // `?` / `q` shouldn't fire global shortcuts — let them pass through
    // as typed characters.
    inputFocused: () => focusedPane() === "workspace",
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
        baseRef: result.baseRef,
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

  /**
   * Confirm + delete a task. Wired from the sidebar's `d` keypress
   * (and a future right-click in Wave 4). Per CLAUDE.md the user's
   * `d` press IS the explicit consent for clearing the worktree, but
   * we still gate behind a confirm because the action is destructive
   * and out-of-frame state (other terminal windows, in-progress writes)
   * could mean "press the wrong key once" → "lose work."
   */
  async function confirmDeleteTask(taskId: string): Promise<void> {
    const task = props.orchestrator.getTask(taskId)
    if (!task) return
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

  // `n` (bare letter) opens the new-task dialog when (a) no task is
  // selected AND (b) the chat composer isn't focused. Otherwise the
  // composer claims `n` as literal input. `ctrl+n` (below) is the
  // always-on path for "task already selected, want to add another".
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !selectedId() && focusedPane() !== "workspace",
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

  // Test-only hidden hotkey affordance for the W4.PR behavior test.
  // Mouse-clicking the CreatePRButton from a PTY harness is awkward
  // (opentui's mouse-event delivery needs SGR capability negotiation
  // that the screen-capture path doesn't honor). When
  // KOBE_TEST_PR_HOTKEY=1 we register a hidden ctrl+y binding that
  // calls the same handler. We chose ctrl+y because (a) it's not in
  // opentui's defaultTextareaKeyBindings (so the composer won't
  // intercept it via preventDefault) and (b) kobe's keymap (see
  // src/tui/lib/keymap.tsx) drops the shift modifier on single-letter
  // keys, so chords like "ctrl+shift+p" never match anything emitted by
  // node-pty. A second test path is the fake-engine HTTP server's POST
  // /pr endpoint (see mountFakeEngineServer above) which bypasses the
  // keymap entirely. Production never sets either env var.
  useBindings(() => ({
    enabled: process.env.KOBE_TEST_PR_HOTKEY === "1" && dialog.stack.length === 0,
    bindings: [
      {
        key: "ctrl+y",
        cmd: () => {
          const task = activeTask()
          if (!task || !task.worktreePath || task.status === "canceled") return
          props.orchestrator.requestPR(task.id).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error("[kobe] requestPR failed:", err)
          })
        },
      },
    ],
  }))

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
  }

  return (
    <box flexDirection="column" flexGrow={1}>
      <TopBar orchestrator={props.orchestrator} activeTask={activeTask} updateInfo={updateInfo} />
      <box flexDirection="row" flexGrow={1}>
        {/* Left: task sidebar. Click anywhere on the sidebar pane to
            focus it. The right edge is a separate <ResizableEdge /> that
            owns the drag-to-resize affordance plus hover/focus colors. */}
        <box flexShrink={0} flexDirection="column" onMouseUp={() => setFocusedPane("sidebar")}>
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
            on this box. */}
        <box
          flexDirection="column"
          flexShrink={0}
          width={workspaceWidth()}
          onMouseUp={() => setFocusedPane("workspace")}
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
            filesHeight signal driving the upper pane. */}
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <box flexShrink={0} height={filesHeight()} flexDirection="column" onMouseUp={() => setFocusedPane("files")}>
            <PaneHeader title="FILES" focused={focusedPane() === "files"} />
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
      paddingLeft={1}
      paddingRight={1}
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
  // exitOnCtrlC: false — opentui's default kills the process on a single
  // Ctrl+C. Jackson wants the standard "first press copies / arms,
  // second press quits" UX, owned by useKobeKeybindings.
  await render(() => <App orchestrator={orchestrator} />, { backgroundColor: "transparent", exitOnCtrlC: false })
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
