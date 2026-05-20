/**
 * `kobe pane <name>` — long-lived CLI process that mounts a single
 * tmux pane. Each pane subprocess connects to the daemon, snapshots
 * state via `hello`, subscribes to task / active events, and renders.
 *
 * Sprint-8: production path now mounts a real `@opentui/solid` Solid
 * app per pane (sidebar / tab-strip / files); the `status` pane and the
 * `--once` smoke path stay on plain-text stdout so unit tests don't
 * have to spin up the opentui renderer.
 *
 * Pane names:
 *   sidebar     — task list with status markers + active highlight
 *   tab-strip   — chat-tab chips for the active task
 *   files       — file tree of the active task's worktree
 *   status      — short status line (task count + active id), plain text
 *
 * Flags:
 *   --once   render one plain-text frame after the initial `hello`,
 *            then exit 0. Used by tests and smoke checks; the
 *            production tmux pane never passes this and stays running.
 */

import { KobeDaemonClient } from "../client/index.ts"
import { defaultDaemonSocketPath } from "../daemon/paths.ts"
import type { DaemonEventHandler } from "../client/index.ts"
import type { DaemonEventName, DaemonRequestName, SerializedTask } from "../daemon/protocol.ts"

export const PANE_NAMES = ["sidebar", "tab-strip", "files", "status"] as const
export type PaneName = (typeof PANE_NAMES)[number]

export interface ParsedPaneArgs {
  readonly name: PaneName
  readonly once: boolean
}

export class PaneError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export function parsePaneArgs(argv: readonly string[]): ParsedPaneArgs {
  let name: string | undefined
  let once = false
  for (const arg of argv) {
    if (arg === "--once") {
      once = true
      continue
    }
    if (arg.startsWith("--")) {
      throw new PaneError(`unknown flag: ${arg}`, "BAD_FLAG")
    }
    if (name === undefined) {
      name = arg
      continue
    }
    throw new PaneError(`unexpected positional arg: ${arg}`, "BAD_ARG")
  }
  if (name === undefined) throw new PaneError("missing pane name", "MISSING_NAME")
  if (!(PANE_NAMES as readonly string[]).includes(name)) {
    throw new PaneError(`unknown pane: ${name}`, "BAD_NAME")
  }
  return { name: name as PaneName, once }
}

export interface PaneRenderState {
  readonly tasks: readonly SerializedTask[]
  readonly activeTaskId: string | null
}

/**
 * Pure helper — given a pane name + state snapshot, produce the line we
 * write to stdout. Kept side-effect-free so unit tests can pin down each
 * pane's output without spawning a subprocess.
 */
export function renderPaneLine(paneName: PaneName, state: PaneRenderState): string {
  const activeTask =
    state.activeTaskId !== null ? (state.tasks.find((t) => t.id === state.activeTaskId) ?? null) : null
  if (paneName === "sidebar") {
    return `[sidebar] tasks: ${state.tasks.length} (active=${state.activeTaskId ?? "none"})`
  }
  if (paneName === "tab-strip") {
    if (!activeTask) return "[tab-strip] task=none tabs: [ ]"
    const tabsText = activeTask.tabs
      .map((tab) => {
        const title = tab.title && tab.title.length > 0 ? tab.title : `chat ${tab.seq}`
        const marker = tab.id === activeTask.activeTabId ? "*" : ""
        return `${title}${marker}`
      })
      .join(" ")
    return `[tab-strip] task=${activeTask.title} tabs: [ ${tabsText} ]`
  }
  if (paneName === "files") {
    return `[files] worktree=${activeTask?.worktreePath ?? "none"}`
  }
  // status
  return `[status] tasks=${state.tasks.length} active=${state.activeTaskId ?? "none"}`
}

/** Inject a fake client in tests; defaults to the real KobeDaemonClient. */
export interface PaneClient {
  connect(): Promise<void>
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
  on(name: DaemonEventName | "*", handler: DaemonEventHandler): () => void
  close(): void
}

export interface RunPaneOptions {
  readonly clientFactory?: (socketPath: string) => PaneClient
  readonly socketPath?: string
  readonly stdout?: (line: string) => void
  readonly stderr?: (line: string) => void
  /**
   * Test seam — fires after the initial hello+render and any subsequent
   * re-renders. The default no-op lets the process stay alive on tmux;
   * tests pass a function that resolves to make `runPane` return.
   */
  readonly onRender?: (line: string) => void
}

export interface RunPaneResult {
  readonly exitCode: number
}

const CLEAR_HOME = "\x1b[2J\x1b[H"

function failJson(message: string, code: string, err: (line: string) => void, exitCode: number): RunPaneResult {
  err(`${JSON.stringify({ error: { message, code } })}\n`)
  return { exitCode }
}

interface HelloPayload {
  readonly tasks: readonly SerializedTask[]
  readonly activeTaskId: string | null
}

interface TaskCreatedPayload {
  readonly task: SerializedTask
}

interface TaskUpdatedPayload {
  readonly taskId: string
  readonly task: SerializedTask
}

interface TaskDeletedPayload {
  readonly taskId: string
}

interface ActiveChangedPayload {
  readonly activeTaskId: string | null
}

export async function runPane(argv: readonly string[], options: RunPaneOptions = {}): Promise<RunPaneResult> {
  const stdout = options.stdout ?? ((line) => process.stdout.write(line))
  const stderr = options.stderr ?? ((line) => process.stderr.write(line))

  let parsed: ParsedPaneArgs
  try {
    parsed = parsePaneArgs(argv)
  } catch (e) {
    if (e instanceof PaneError) return failJson(e.message, e.code, stderr, 2)
    return failJson(e instanceof Error ? e.message : String(e), "BAD_FLAG", stderr, 2)
  }

  const socketPath = options.socketPath ?? defaultDaemonSocketPath()
  const client = (options.clientFactory ?? ((p) => new KobeDaemonClient(p) as PaneClient))(socketPath)

  try {
    await client.connect()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return failJson(`no daemon at ${socketPath} (run \`kobe daemon start\`): ${msg}`, "BAD_DAEMON", stderr, 2)
  }

  // Mutable state mirror — updated by event handlers, re-read by render().
  const tasksById = new Map<string, SerializedTask>()
  let activeTaskId: string | null = null

  function snapshot(): PaneRenderState {
    return { tasks: Array.from(tasksById.values()), activeTaskId }
  }

  function render(): void {
    const line = renderPaneLine(parsed.name, snapshot())
    stdout(`${CLEAR_HOME}${line}\n`)
    options.onRender?.(line)
  }

  let helloPayload: HelloPayload
  try {
    helloPayload = await client.request<HelloPayload>("hello", {
      clientId: `pane:${parsed.name}`,
      version: "pane",
    })
    for (const task of helloPayload.tasks) tasksById.set(task.id, task)
    activeTaskId = helloPayload.activeTaskId
    render()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    client.close()
    return failJson(`hello failed: ${msg}`, "HELLO_FAILED", stderr, 2)
  }

  if (parsed.once) {
    client.close()
    return { exitCode: 0 }
  }

  // Solid render path — sidebar / tab-strip / files mount real opentui
  // components. The `status` pane stays on the plain-text re-render
  // loop below; it's small, not user-facing in tmux (the tmux
  // status-line owns the real status), and keeping it text-only saves
  // a renderer per session.
  if (parsed.name === "sidebar" || parsed.name === "tab-strip" || parsed.name === "files") {
    return await runSolidPane(parsed.name, client, helloPayload)
  }

  // Plain-text re-render loop (used today by the `status` pane).
  client.on("task.created", (frame) => {
    const payload = frame.payload as TaskCreatedPayload
    tasksById.set(payload.task.id, payload.task)
    render()
  })
  client.on("task.updated", (frame) => {
    const payload = frame.payload as TaskUpdatedPayload
    tasksById.set(payload.taskId, payload.task)
    render()
  })
  client.on("task.deleted", (frame) => {
    const payload = frame.payload as TaskDeletedPayload
    tasksById.delete(payload.taskId)
    render()
  })
  client.on("active.changed", (frame) => {
    const payload = frame.payload as ActiveChangedPayload
    activeTaskId = payload.activeTaskId
    render()
  })

  // Exit cleanly on daemon shutdown so tmux gets a fresh pane on next
  // daemon start instead of a stuck client.
  return await new Promise<RunPaneResult>((resolve) => {
    client.on("daemon.stopping", () => {
      client.close()
      resolve({ exitCode: 0 })
    })
  })
}

/**
 * Solid render path — mounts an opentui-rendered Solid app for the
 * sidebar / tab-strip / files panes. Late dynamic imports keep
 * `@opentui/solid` out of the static graph of the `--once` smoke
 * path (tests under Node hit only the plain-text branch above).
 */
async function runSolidPane(
  name: "sidebar" | "tab-strip" | "files",
  client: PaneClient,
  hello: HelloPayload,
): Promise<RunPaneResult> {
  const { createPaneSignals, subscribePaneSignals } = await import("../tui/panes/subprocess/shared.ts")
  const { mountSolidPane } = await import("../tui/panes/subprocess/host.tsx")
  // Pass the daemon client into the signal store so mouse-click handlers
  // in SidebarPane / TabStripPane can dispatch fire-and-forget RPCs
  // (switch-task / switch-tab / new-task) without each component knowing
  // about the client.
  const signals = createPaneSignals(hello, client as unknown as Parameters<typeof createPaneSignals>[1])
  // Subscribe BEFORE render so any event arriving during the renderer's
  // async mount lands in the signal store (Solid re-renders on next tick).
  subscribePaneSignals(client as unknown as Parameters<typeof subscribePaneSignals>[0], signals)

  // Exit cleanly on daemon shutdown — process.exit beats trying to
  // tear down the renderer from outside its render() promise, and
  // tmux respawns the pane subprocess automatically when the daemon
  // comes back.
  client.on("daemon.stopping", () => {
    client.close()
    process.exit(0)
  })

  await mountSolidPane(name, signals)
  client.close()
  return { exitCode: 0 }
}

export async function runPaneSubcommand(argv: readonly string[]): Promise<void> {
  const { exitCode } = await runPane(argv)
  if (exitCode !== 0) process.exit(exitCode)
}
