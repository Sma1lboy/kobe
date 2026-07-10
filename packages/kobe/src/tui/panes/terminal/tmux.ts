/**
 * tmux-backed interactive sessions (v0.6).
 *
 * One tmux session per Task (`kobe-<taskId>`, on the dedicated
 * `tmux -L kobe` socket). Each **window** in the session is a **chat
 * tab** — an independent claude conversation on the same worktree —
 * and every window has the same four-pane workspace:
 *
 *     ┌────────┬──────────────────┬───────────────┐
 *     │ tasks  │   claude         │  ops          │
 *     │ (left) │   (@kobe_role)   ├───────────────┤
 *     │        │                  │  shell        │
 *     └────────┴──────────────────┴───────────────┘
 *
 * The tmux status-bar window list is the chat-tab switcher; the left
 * Tasks pane switches between task sessions. `Ctrl+T` opens a new chat
 * tab (window), `Ctrl+[` / `Ctrl+]` move to the previous / next
 * chat tab, `Ctrl+W` closes the current chat tab when at least one
 * sibling window remains, and `F2` renames the current chat tab.
 * Everything is rendered by tmux, so claude repaints at native speed
 * without kobe's outer renderer fighting for the TTY.
 *
 * `Ctrl+Q` is two-stage: it first focuses the current window's Tasks
 * pane, and only detaches back to the launching shell on a second press
 * from the Tasks pane. `Ctrl+h/j/k/l` move
 * between panes. All bindings are server-scoped on `-L kobe`, so the
 * user's own tmux is untouched. Sessions persist across detach AND a
 * kobe restart.
 *
 * This file is the session APPLIER: `ensureSession`'s observe → decide →
 * apply pipeline plus the engine-launch weaving (init script, remote
 * wrap, session option tagging, server-scoped bindings). Its sibling
 * modules hold the rest of the machinery and are re-exported below so
 * callers keep one import path:
 *
 *   - `session-decision.ts` (`src/tmux/`) — the pure reuse/respawn/
 *     rebuild DECISION; `session-layout.ts` — the pure pane commands +
 *     sizes; `keybindings.ts` — the user-resolvable tmux key set.
 *   - `./chattab.ts` — ChatTab lifecycle: window formats/bindings,
 *     `buildPanesAround`, `newChatTab`, and the dedicated single-page
 *     windows (settings / new-task / update / quick-task).
 *   - `./pane-heal.ts` — version-tagged in-place respawns of the
 *     kobe-owned Tasks/Ops panes + the vendor-switch engine respawn.
 *   - `./launch.ts` — shared launch-line helpers (env pinning, remote
 *     engine wrap).
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

import { runTmux, runTmuxCapturing, runTmuxSequence, sessionExists } from "@/tmux/client"
import { ENGINE_PANE_ROLE, TASKS_PANE_ROLE } from "@/tmux/session-layout"
import { runLayoutAction } from "./layout-actions"
import { recordGen } from "./layout-coord"
import { healWorkspaceLayout, workspaceLayoutPaneCommands } from "./pane-heal"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`direct.ts`, pane hosts) keep their `./tmux` path.
export {
  attachArgv,
  currentSessionName,
  killSession,
  sessionExists,
  switchClientBeforeKill,
  tmuxAvailable,
  tmuxSessionName,
} from "@/tmux/client"

// Re-export the ChatTab lifecycle + heal surfaces extracted into sibling
// modules, so every pre-split importer (hosts, CLI handlers, tests) keeps
// resolving them from `panes/terminal/tmux`.
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
  captureGlobalLayout,
  captureGlobalLayoutOnDrag,
  healSessionLayout,
  refreshKobeWorkspacePanes,
} from "./pane-heal"
export { PANE_VERSION_OPTION } from "./pane-heal-plan"
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

/**
 * Keep a second SSH/local monitor from resizing the task window away from the
 * client we are entering from. tmux still has one grid per session/window, so
 * clients with different terminal sizes cannot all own the grid at once; marking
 * the already-attached, conflicting clients `ignore-size` lets them keep viewing
 * while the actively-entering client drives the size.
 */
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

/**
 * Fit a session's active window to THIS terminal and heal the layout BEFORE
 * attaching, so the very first painted frame is already correct.
 *
 * Without this the attach itself is the resize: the session's window is at a
 * stale size (built detached, or persisted from a different terminal), tmux
 * reflows every pane PROPORTIONALLY when the client lands — the rail blows up —
 * and the `window-resized` hook only snaps it back ~300ms later. That snap is
 * the visible "flash". Resizing the window to the client's size up front (while
 * nothing is on screen yet, pre-attach) means the attach causes NO reflow, and
 * healing at that final size leaves the layout right from frame one. The
 * `window-resized` hook still covers later live terminal resizes. No-op size
 * when the terminal dimensions are unknown (degrades to today's behaviour).
 */
export async function prepareWindowForAttach(session: string): Promise<void> {
  // Stamp `resize` BEFORE the resize-window so a `window-layout-changed` capture
  // it triggers skips this in-flight resize (healWorkspaceLayout re-stamps too;
  // this closes the gap before that runs). See healWorkspaceLayout / layout-coord.
  recordGen(session, "resize")
  const clientSize = tmuxInitialClientSize()
  await ignoreConflictingSizeClients(session, clientSize)
  const sizeArgs = clientSize ? ["-x", `${clientSize.columns}`, "-y", `${clientSize.rows}`] : []
  if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${session}`, ...sizeArgs])
  await healWorkspaceLayout(session)
}

/**
 * Width/height args for the tmux client THIS process is attached inside, read
 * from the current window's CONTENT size (`window_width`/`window_height` —
 * already net of the status bar). The in-tmux counterpart to
 * {@link tmuxInitialSizeArgs}: a pane host (the Tasks pane, the quick-task
 * window) has its `process.stdout` sized to its OWN narrow pane, so stdout
 * would fit the target window to the wrong (pane) size. The attached client's
 * Use the current CLIENT size, not the current WINDOW size. If this client is
 * already looking at a letterboxed window, `window_width` / `window_height` are
 * the stale small grid we are trying to escape; `client_width` /
 * `client_height` are the real terminal size that should drive the target.
 */
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

/**
 * Fit + heal a session's window to the CURRENTLY ATTACHED client BEFORE a
 * `switch-client` lands on it — the switch counterpart to
 * {@link prepareWindowForAttach}.
 *
 * `prepareWindowForAttach` fits to `process.stdout`, correct when attaching
 * from OUTSIDE tmux (stdout is the real terminal — `direct.ts`). The Tasks-pane
 * "open task" path is different: it runs INSIDE a tmux pane, so `process.stdout`
 * is the host pane's narrow pty, and it never fit/healed the target at all
 * before switching. The target session — built detached at that wrong pane size
 * (its `new-session -x/-y` also read the narrow stdout), or sitting at a stale
 * size — then reflows PROPORTIONALLY the instant the full-terminal client
 * switches to it: the absolute Tasks rail blows up and the `window-resized` hook
 * only snaps it back a beat later. That snap is the visible "first open jumps
 * from a default size to the aligned size". Sizing the window to the attached
 * client's dims and healing here — while the target is still detached, nothing
 * on screen — makes the switch cause NO reflow. No-op size when not in tmux.
 */
export async function prepareWindowForSwitch(session: string): Promise<void> {
  // Stamp `resize` BEFORE the resize-window so a `window-layout-changed` capture
  // it triggers skips this in-flight resize (healWorkspaceLayout re-stamps too;
  // this closes the gap before that runs). See healWorkspaceLayout / layout-coord.
  recordGen(session, "resize")
  const info = await attachedWindowInfo()
  await ignoreConflictingSizeClients(session, info.clientSize, { currentClientName: info.clientName })
  const sizeArgs = info.sizeArgs
  if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${session}`, ...sizeArgs])
  await healWorkspaceLayout(session)
}

/**
 * Switch the attached client into a session — the ONE way to land a client on a
 * kobe tmux Session. The fit ({@link prepareWindowForSwitch}) is welded to the
 * `switch-client` so no caller can switch into an unfitted window: that gap is
 * exactly where the reflow ("window resize") bugs lived — the cold-open split-at-
 * narrow-size and the delete-path switch both forgot the fit independently. With
 * one owner the "fit before switch" invariant is structural, not per-caller
 * discipline. `=${session}` is the exact-match target form.
 */
export async function enterWindow(session: string): Promise<void> {
  await prepareWindowForSwitch(session)
  await runTmux(["switch-client", "-t", `=${session}`])
}

/**
 * Re-pin a session's active window to the size of the client that just resized
 * — the `client-resized` tmux hook handler.
 *
 * `prepareWindowForAttach` / `prepareWindowForSwitch` call `resize-window`,
 * which flips the window's `window-size` to `manual` (verified on tmux 3.6). The
 * window then no longer auto-grows when the terminal grows, so `window-resized`
 * — which fires only when the window ACTUALLY resizes — never runs for the grow
 * direction, and the UI stays letterboxed at the old (smaller) size until the
 * next task switch or a reopen. `client-resized` fires on every terminal size
 * change regardless of the manual pin, so we re-apply the resize-window here
 * (the outer frame follows the terminal) and heal the rail (the inner layout
 * stays pinned). The client size arrives as explicit args: the hook's detached
 * `run-shell -b` is not attached to a client, so it cannot read `#{client_*}`
 * from its own `display-message`. No-op when the size is unknown.
 */
export async function resyncWindowToClient(
  session: string,
  opts: {
    readonly size: TmuxClientSize | null
    readonly status: string | undefined
    readonly clientName?: string
  },
): Promise<void> {
  if (!opts.size) return
  // Stamp `resize` BEFORE the resize-window so a `window-layout-changed` capture
  // it triggers skips this in-flight resize.
  recordGen(session, "resize")
  await ignoreConflictingSizeClients(session, opts.size, { currentClientName: opts.clientName })
  const sizeArgs = tmuxWindowSizeArgsForClient(opts.size, { status: opts.status })
  // Batch the window resize and the rail/right-column re-pin into ONE tmux
  // command sequence so tmux repaints once: a separate resize-window (which
  // reflows the rail proportionally wider) followed by a separate heal (which
  // snaps it back) paints the blown-up intermediate frame — the visible "flash".
  // `force` because the re-pins are planned from the PRE-resize snapshot, where
  // the rail still reads its pinned width (see workspaceLayoutPaneCommands).
  const { commands } = await workspaceLayoutPaneCommands(session, { force: true })
  await runTmuxSequence([["resize-window", "-t", `=${session}`, ...sizeArgs], ...commands])
}

// Session ensure/build (`ensureSession`), the directional pane-focus
// keybinding helpers it consumes, and the observe-session helpers all live
// in tmux-session.ts / tmux-session-bindings.ts (file-size cap) —
// re-exported here so every pre-split importer (hosts, CLI handlers, tests)
// keeps resolving them from `panes/terminal/tmux`.
export { type EnsureSessionOpts, ensureSession, observeSessionVendor, parseObservedSession } from "./tmux-session.ts"
export { type FocusDirection, focusBindCommand, tasksRestoreEdgeCommand } from "./tmux-session-bindings.ts"

/**
 * Focus the source window's Tasks pane, restoring it first if the rail is
 * hidden. This is the first stage of two-stage Ctrl+Q (`kobe focus-tasks`) and
 * the recovery path for focus-left when the rail is hidden. If no source window
 * is provided, it falls back to the session's active window for manual CLI use.
 * No-op when the session is gone or the target window cannot restore a Tasks
 * pane. Returns the pane id it selected, or `""`.
 */
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
    // Full-window tabs (file preview / editor windows) have neither a Tasks
    // pane nor an engine pane. Ctrl+Q there must be a no-op — restoring would
    // graft a Tasks rail into the preview. Only a real workspace window
    // (engine pane present, rail crashed/missing) earns the restore.
    if (!(await paneIdByRoleInWindow(session, ENGINE_PANE_ROLE, opts.windowId))) return ""
    await runLayoutAction(session, "tasks-restore", { windowId: opts.windowId })
    tasksPane = await paneIdByRoleInWindow(session, TASKS_PANE_ROLE, opts.windowId)
  }
  if (!tasksPane) return ""
  await runTmux(["select-pane", "-t", tasksPane])
  return tasksPane
}
