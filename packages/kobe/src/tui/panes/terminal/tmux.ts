import { runTmux, runTmuxCapturing, runTmuxSequence, sessionExists } from "@/tmux/client"
import { ENGINE_PANE_ROLE, TASKS_PANE_ROLE } from "@/tmux/session-layout"
import { runLayoutAction } from "./layout-actions"
import { recordGen } from "./layout-coord"
import { healWorkspaceLayout, workspaceLayoutPaneCommands } from "./pane-heal"

export {
  attachArgv,
  currentSessionName,
  killSession,
  sessionExists,
  switchClientBeforeKill,
  tmuxAvailable,
  tmuxSessionName,
} from "@/tmux/client"

export {
  CHAT_TAB_ENGINE_PROMPT,
  CHAT_TAB_STATE_OPTION,
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
  newChatTab,
  openHelpTab,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  openWorktreesTab,
  quickCreate,
} from "./chattab"
export {
  PANE_VERSION_OPTION,
  captureGlobalLayout,
  captureGlobalLayoutOnDrag,
  healSessionLayout,
  refreshKobeWorkspacePanes,
} from "./pane-heal"
export { runLayoutAction, type LayoutAction } from "./layout-actions"

export function tmuxInitialSizeArgs(
  stdout: { columns?: number; rows?: number } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const size = tmuxInitialClientSize(stdout, env)
  return size ? ["-x", `${size.columns}`, "-y", `${size.rows}`] : []
}

export type TmuxClientSize = {
  readonly columns: number
  readonly rows: number
}

export function tmuxInitialClientSize(
  stdout: { columns?: number; rows?: number } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): TmuxClientSize | null {
  const columns = positiveInt(stdout.columns) ?? positiveInt(env.COLUMNS)
  const rows = positiveInt(stdout.rows) ?? positiveInt(env.LINES)
  return columns && rows ? { columns, rows } : null
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export type TmuxClientRow = {
  readonly name: string
  readonly session: string
  readonly width: number
  readonly height: number
  readonly flags: string
}

const CLIENT_LIST_FORMAT = "#{client_name}\t#{client_session}\t#{client_width}\t#{client_height}\t#{client_flags}"

export function parseTmuxClientRows(stdout: string): TmuxClientRow[] {
  const rows: TmuxClientRow[] = []
  for (const raw of stdout.split("\n")) {
    const [name, session, widthRaw, heightRaw, flags] = raw.split("\t")
    const width = positiveInt(widthRaw?.trim())
    const height = positiveInt(heightRaw?.trim())
    if (!name?.trim() || !session?.trim() || !width || !height) continue
    rows.push({
      name: name.trim(),
      session: session.trim(),
      width,
      height,
      flags: flags?.trim() ?? "",
    })
  }
  return rows
}

export function clientsWithConflictingSize(
  clients: readonly TmuxClientRow[],
  session: string,
  desired: TmuxClientSize,
  opts: { readonly currentClientName?: string } = {},
): string[] {
  return clients
    .filter((client) => client.session === session)
    .filter((client) => client.name !== opts.currentClientName)
    .filter((client) => client.width !== desired.columns || client.height !== desired.rows)
    .map((client) => client.name)
}

export function tmuxWindowSizeArgsForClient(
  size: TmuxClientSize,
  opts: { readonly status: string | undefined },
): string[] {
  const contentHeight = Math.max(1, size.rows - (opts.status?.trim() === "on" ? 1 : 0))
  return ["-x", `${size.columns}`, "-y", `${contentHeight}`]
}

async function ignoreConflictingSizeClients(
  session: string,
  desired: TmuxClientSize | null,
  opts: { readonly currentClientName?: string } = {},
): Promise<void> {
  if (!desired) return
  const { code, stdout } = await runTmuxCapturing(["list-clients", "-t", `=${session}`, "-F", CLIENT_LIST_FORMAT])
  if (code !== 0) return
  const conflicts = clientsWithConflictingSize(parseTmuxClientRows(stdout), session, desired, opts)
  const commands: (readonly string[])[] = []
  if (opts.currentClientName) commands.push(["refresh-client", "-f", "!ignore-size", "-t", opts.currentClientName])
  for (const client of conflicts) commands.push(["refresh-client", "-f", "ignore-size", "-t", client])
  if (commands.length > 0) await runTmuxSequence(commands)
}

export async function prepareWindowForAttach(session: string): Promise<void> {
  recordGen(session, "resize")
  const clientSize = tmuxInitialClientSize()
  await ignoreConflictingSizeClients(session, clientSize)
  const sizeArgs = clientSize ? ["-x", `${clientSize.columns}`, "-y", `${clientSize.rows}`] : []
  if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${session}`, ...sizeArgs])
  await healWorkspaceLayout(session)
}

export async function attachedWindowInfo(): Promise<{
  readonly sizeArgs: string[]
  readonly clientSize: TmuxClientSize | null
  readonly clientName: string | undefined
}> {
  const { code, stdout } = await runTmuxCapturing([
    "display-message",
    "-p",
    "#{client_name}\t#{client_width}\t#{client_height}\t#{status}",
  ])
  if (code !== 0) return { sizeArgs: [], clientSize: null, clientName: undefined }
  const [clientName, clientWidth, clientHeight, status] = stdout.trim().split("\t")
  const cw = positiveInt(clientWidth)
  const ch = positiveInt(clientHeight)
  const clientSize = cw && ch ? { columns: cw, rows: ch } : null
  return {
    sizeArgs: clientSize ? tmuxWindowSizeArgsForClient(clientSize, { status }) : [],
    clientSize,
    clientName: clientName?.trim() || undefined,
  }
}

export async function prepareWindowForSwitch(session: string): Promise<void> {
  recordGen(session, "resize")
  const info = await attachedWindowInfo()
  await ignoreConflictingSizeClients(session, info.clientSize, { currentClientName: info.clientName })
  const sizeArgs = info.sizeArgs
  if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${session}`, ...sizeArgs])
  await healWorkspaceLayout(session)
}

export async function enterWindow(session: string): Promise<void> {
  await prepareWindowForSwitch(session)
  await runTmux(["switch-client", "-t", `=${session}`])
}

export async function resyncWindowToClient(
  session: string,
  opts: {
    readonly size: TmuxClientSize | null
    readonly status: string | undefined
    readonly clientName?: string
  },
): Promise<void> {
  if (!opts.size) return
  recordGen(session, "resize")
  await ignoreConflictingSizeClients(session, opts.size, { currentClientName: opts.clientName })
  const sizeArgs = tmuxWindowSizeArgsForClient(opts.size, { status: opts.status })
  const { commands } = await workspaceLayoutPaneCommands(session, { force: true })
  await runTmuxSequence([["resize-window", "-t", `=${session}`, ...sizeArgs], ...commands])
}

export { type EnsureSessionOpts, ensureSession, observeSessionVendor, parseObservedSession } from "./tmux-session.ts"
export { type FocusDirection, focusBindCommand, tasksRestoreEdgeCommand } from "./tmux-session-bindings.ts"

async function paneIdByRoleInWindow(session: string, role: string, windowId?: string): Promise<string> {
  const target = windowId?.trim() || `=${session}`
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-t", target, "-F", "#{pane_id}\t#{@kobe_role}"])
  if (code !== 0) return ""
  for (const line of stdout.split("\n")) {
    const [paneId, paneRole] = line.split("\t")
    if (paneId?.trim() && paneRole?.trim() === role) return paneId.trim()
  }
  return ""
}

export async function selectTasksPane(session: string, opts: { readonly windowId?: string } = {}): Promise<string> {
  if (!(await sessionExists(session))) return ""
  let tasksPane = await paneIdByRoleInWindow(session, TASKS_PANE_ROLE, opts.windowId)
  if (!tasksPane) {
    if (!(await paneIdByRoleInWindow(session, ENGINE_PANE_ROLE, opts.windowId))) return ""
    await runLayoutAction(session, "tasks-restore", { windowId: opts.windowId })
    tasksPane = await paneIdByRoleInWindow(session, TASKS_PANE_ROLE, opts.windowId)
  }
  if (!tasksPane) return ""
  await runTmux(["select-pane", "-t", tasksPane])
  return tasksPane
}
