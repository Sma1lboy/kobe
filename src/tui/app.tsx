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
import { ChatPlaceholder } from "./panes/chat-placeholder/Chat"
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

type NewTaskInput = { repo: string; title: string }

function NewTaskDialog(props: { onSubmit: (v: NewTaskInput) => void; onCancel: () => void; defaultRepo: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [field, setField] = createSignal<"title" | "repo">("title")
  const [title, setTitle] = createSignal("")
  const [repo, setRepo] = createSignal(props.defaultRepo)

  function commit() {
    const t = title().trim()
    const r = repo().trim()
    if (!t || !r) return
    props.onSubmit({ title: t, repo: r })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        cmd: () => setField((f) => (f === "title" ? "repo" : "title")),
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
        <text fg={field() === "title" ? theme.accent : theme.textMuted}>title</text>
        <input
          value={title()}
          placeholder="e.g. fix login redirect"
          focused={field() === "title"}
          onInput={(v: string) => setTitle(v)}
          onSubmit={() => {
            if (!title().trim()) return
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
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)

  const activeTask = createMemo(() => {
    const id = selectedId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
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

  // `n` opens the new-task dialog. We bind at the shell level so it
  // works regardless of which pane has focus. Critical: the binding
  // is `enabled` only when no dialog is open AND no input field has
  // claimed focus (the chat composer's input). Without the input
  // guard, typing the letter "n" inside the chat composer would open
  // a second new-task dialog. Without the dialog guard, typing "n"
  // inside the new-task dialog's title field would do the same.
  //
  // We approximate "input focused" by "a task is selected" — the
  // chat input only renders + auto-focuses once a task exists. For
  // G2 that's adequate; Wave 3's real chat pane takes over focus
  // management.
  useBindings(() => ({
    enabled: dialog.stack.length === 0 && !selectedId(),
    bindings: [
      {
        key: "n",
        cmd: async () => {
          const result = await showNewTaskDialog(dialog, process.cwd())
          if (!result) return
          try {
            const created = await props.orchestrator.createTask({
              repo: result.repo,
              title: result.title,
              prompt: "", // first prompt comes via chat input
            })
            setSelectedId(created.id)
          } catch (err) {
            // Surface failure as a transient banner via `system` line in
            // the chat — but the chat may not be subscribed yet (no
            // task selected). For G2 we just print to stderr so the
            // PTY captures it.
            // eslint-disable-next-line no-console
            console.error("[kobe] createTask failed:", err)
          }
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.background}>
      <TopBar activeTitle={activeTask()?.title} />
      <box flexDirection="row" flexGrow={1}>
        <Sidebar tasks={tasksAcc} onSelect={(id: string) => setSelectedId(id)} selectedId={selectedId()} />
        <ChatPlaceholder orchestrator={props.orchestrator} taskId={selectedId()} title={activeTask()?.title} />
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
