/**
 * G2 application shell — TEMPORARY SCAFFOLDING.
 *
 * EXPLICITLY THROWAWAY. Wave 3 owns the real 5-pane layout (preview,
 * file tree, terminal, chat). This file wires the bare minimum that
 * proves end-to-end orchestration: sidebar (Stream F) + chat
 * placeholder + new-task dialog + the Orchestrator (Stream E).
 *
 * Why a separate file from `tui/index.tsx`: the prior `index.tsx`
 * mounts a banner-only Shell. We don't delete it (CLAUDE.md hard rule)
 * — we keep `startTui()` there but switch what it renders. This file
 * is the new mount target; `index.tsx`'s Shell is now unused but
 * preserved for the historical commit log.
 *
 * Engine selection:
 *   - Default: real `ClaudeCodeLocal` (production binary).
 *   - With `KOBE_TEST_ENGINE=fake`: a `FakeAIEngine` instance, mounted
 *     onto `(globalThis as any).__KOBE_FAKE_ENGINE__` as the side-channel
 *     for the G2 behavior test. The behavior test runs the real kobe
 *     binary in a PTY but pulls the fake engine off globalThis to
 *     script events. The PTY child shares globalThis with the test only
 *     because vitest spawns kobe as a subprocess — actually it doesn't.
 *
 *     CORRECTION: Vitest spawns kobe in a *child process* via the PTY
 *     driver. globalThis isn't shared across processes. So the
 *     side-channel mechanism is: when `KOBE_TEST_ENGINE=fake`, kobe
 *     spawns a tiny HTTP server on a free port, writes the port to
 *     `process.env.KOBE_TEST_FAKE_PORT` (which the test reads via the
 *     PTY's environment, but the PTY env was set BY the test, so the
 *     test already knows the port — actually it doesn't, the port is
 *     allocated inside kobe).
 *
 *     CORRECTION 2: We pick a fixed strategy. The test PRE-CHOOSES the
 *     port and passes it via `KOBE_TEST_FAKE_PORT`. Kobe binds the
 *     fake-engine HTTP server on that port. The test scripts events
 *     by POSTing JSON to it. This avoids any need for kobe to publish
 *     a port back to the test.
 *
 *     The endpoints:
 *       POST /script    body: { sessionId, events: EngineEvent[] }
 *       POST /finish    body: { sessionId }
 *       GET  /sessions  body: { sessions: string[] }   (debug)
 *
 *     This is intentionally minimal. The whole thing is deleted in
 *     Wave 3 along with this file.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { TextAttributes } from "@opentui/core"
import { render } from "@opentui/solid"
import { type Accessor, Show, createEffect, createMemo, createSignal } from "solid-js"
import { ClaudeCodeLocal } from "../engine/claude-code-local/index.ts"
import { Orchestrator } from "../orchestrator/core.ts"
import { TaskIndexStore } from "../orchestrator/index/store.ts"
import { GitWorktreeManager } from "../orchestrator/worktree/manager.ts"
import type { AIEngine } from "../types/engine.ts"
import { HelpDialog } from "./component/help-dialog"
import { CommandPaletteProvider } from "./context/command-palette"
import { useKobeKeybindings } from "./context/keybindings"
import { KVProvider } from "./context/kv"
import { SyncProvider } from "./context/sync"
import { ThemeProvider, useTheme } from "./context/theme"
import { useBindings } from "./lib/keymap"
import { Chat } from "./panes/chat/Chat"
import { Sidebar } from "./panes/sidebar/Sidebar"
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

function StatusBar(props: { active?: string }) {
  const { theme } = useTheme()
  return (
    <box
      flexDirection="row"
      gap={2}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
      backgroundColor={theme.backgroundPanel}
    >
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>n</span> new task
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>enter</span> select / send
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>?</span> help
      </text>
      <text fg={theme.textMuted}>
        <span style={{ fg: theme.accent }}>q</span> quit
      </text>
      <Show when={props.active}>
        <text fg={theme.success}>active: {props.active}</text>
      </Show>
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
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <TopBar activeTitle={activeTask()?.title} />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar tasks={tasksAcc} onSelect={(id: string) => setSelectedId(id)} selectedId={selectedId} />
        <Chat
          orchestrator={props.orchestrator}
          taskId={taskIdAcc}
          title={activeTitleAcc}
          pendingPrompt={pendingPromptForActive}
          onPendingPromptConsumed={() => setPendingPrompt(null)}
        />
      </box>
      <StatusBar active={activeTask()?.title} />
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
  await render(() => <App orchestrator={orchestrator} />)
  // Side-effect: silence the "no usage" lint warning if any.
  void join
}
