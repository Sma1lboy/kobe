/**
 * `kobe pane <name>` — short-lived (or rather: long-lived) CLI process
 * that mounts a single tmux pane. Each pane subprocess connects to the
 * daemon, snapshots state via `hello`, then subscribes to task / active
 * events and re-renders on every change.
 *
 * Sprint-4 scope: rendering is plain text (no opentui). The pane writes
 * one line to stdout per state, with an ANSI clear-screen-and-home prefix
 * so subsequent renders replace the previous line in place. The real
 * opentui-rendered pane UIs land in sprints 5/6.
 *
 * Pane names:
 *   sidebar     — task list summary
 *   tab-strip   — chat-tab strip for the active task
 *   files       — worktree path for the active task
 *   status      — short status line (task count + active id)
 *
 * Flags:
 *   --once   render once after the initial `hello`, then exit 0. Used by
 *            tests and smoke checks; the production tmux pane never
 *            passes this and stays running.
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

  try {
    const hello = await client.request<HelloPayload>("hello", { clientId: `pane:${parsed.name}`, version: "pane" })
    for (const task of hello.tasks) tasksById.set(task.id, task)
    activeTaskId = hello.activeTaskId
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

  // Subscribe to the four event names that affect any pane's render.
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

export async function runPaneSubcommand(argv: readonly string[]): Promise<void> {
  const { exitCode } = await runPane(argv)
  if (exitCode !== 0) process.exit(exitCode)
}
