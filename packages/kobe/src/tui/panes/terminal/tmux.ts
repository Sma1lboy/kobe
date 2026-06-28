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

import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId, withDispatcherProtocol, withWorktreeProtocol } from "@/engine/interactive-command"
import { worktreeInitMarkerPath } from "@/env"
import { localSpawnCwd, remoteKeyForRepo } from "@/exec/resolve"
import type { EngineLaunchInit } from "@/state/repo-init"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  KOBE_TMUX_SOCKET,
  killSession,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
  setSessionOption,
  setWindowOption,
} from "@/tmux/client"
import { clipboardBinaryOnPath, clipboardTmuxConfig, resolveClipboardCopyCommand } from "@/tmux/clipboard"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_LEGACY_LAYOUT_ROOT_KEYS,
  TMUX_SINGLE_BINDING_DEFAULTS,
  chordToTmuxKey,
  isTmuxPrefixBindingId,
  resolveUserTmuxKeys,
} from "@/tmux/keybindings"
import { deliverFirstEngineMessage } from "@/tmux/prompt-delivery"
import { type ObservedSession, decideSessionAction } from "@/tmux/session-decision"
import {
  HIDDEN_TASKS_PANE_OPTION,
  engineLaunchLine,
  openUrlCommand,
  resolveRepoInitTimeoutSeconds,
  shellQuote,
  shellQuoteArgv,
} from "@/tmux/session-layout"
import { applyTmuxChromeTheme } from "@/tui/lib/tmux-border-theme"
import {
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  buildPanesAround,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
} from "./chattab"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { runLayoutAction } from "./layout-actions"
import { recordGen } from "./layout-coord"
import { healWorkspaceLayout, relaunchEngineInAllWindows, workspaceLayoutPaneCommands } from "./pane-heal"

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
async function attachedWindowInfo(): Promise<{
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

/** Direction flag → the tmux format var that is `1` when the pane sits at that edge. */
const FOCUS_EDGE_VARS = {
  "-L": "pane_at_left",
  "-D": "pane_at_bottom",
  "-U": "pane_at_top",
  "-R": "pane_at_right",
} as const

export type FocusDirection = keyof typeof FOCUS_EDGE_VARS

/**
 * One directional pane-focus binding, edge-guarded so it never WRAPS.
 *
 * Bare `select-pane -L` wraps at the window edge — ctrl+h from the
 * leftmost Tasks pane landed on the RIGHTMOST pane, which reads as a
 * teleport, not a move. The guard makes an edge press a no-op instead:
 * `if-shell -F "#{?pane_at_left,,1}" "select-pane -L"` expands the
 * conditional to `""` at the edge (falsy → if-shell runs nothing; the
 * else command is simply OMITTED, which parses fine) and `"1"` elsewhere
 * (truthy → the move runs). Verified live on tmux 3.5a (scratch `-L`
 * socket): a real attached client's ctrl+h was a no-op on the leftmost
 * pane and still moved left from a middle pane; same for the
 * top/bottom/right edge vars. Wraps whatever key the user resolved for
 * the `tmux.focus` group — the guard lives on the command side.
 *
 * ZOOM exemption: a zoomed pane reports ALL FOUR `pane_at_*` flags as 1
 * (verified live), so a bare edge guard would turn every focus chord
 * into a dead key while zoomed. The outer `window_zoomed_flag`
 * conditional bypasses the guard when zoomed, so the chord falls
 * through to plain `select-pane` — which unzooms and moves, exactly the
 * pre-guard behavior (also verified live: zoomed %1 + ctrl+h → %0,
 * zoom released).
 */
export function focusBindCommand(key: string, dir: FocusDirection, edgeCommand?: string): readonly string[] {
  const condition = `#{?window_zoomed_flag,1,#{?${FOCUS_EDGE_VARS[dir]},,1}}`
  if (edgeCommand) {
    return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`, edgeCommand]
  }
  return ["bind-key", "-n", key, "if-shell", "-F", condition, `select-pane ${dir}`]
}

export interface EnsureSessionOpts {
  readonly name: string
  /** Working directory for every pane in the new session. */
  readonly cwd: string
  /** argv that pane 0 (the claude pane) runs. */
  readonly command: readonly string[]
  /**
   * Shell command line that pane 1 (the Ops pane) runs. Defaults to
   * the `kobe ops` FileTree pane (see `tmux/session-layout.ts`
   * `opsPaneCommand`); override is the test/escape hatch.
   */
  readonly opsCommand?: string
  /**
   * Stable kobe task id — used to build the default `kobe ops` argv
   * and the `target-pane` selector. Optional so callers that supply
   * their own `opsCommand` don't need to pass it.
   */
  readonly taskId?: string
  /**
   * Engine vendor — tagged on the session (`@kobe_vendor`) so a new
   * chat tab (`newChatTab`) relaunches the SAME engine, not a
   * hard-coded `claude`.
   */
  readonly vendor?: string
  /**
   * The task's repo/project key — a local repo root path, or a remote
   * project's `ssh://user@host[:port]` key. Callers pass `task.repo` AS-IS;
   * remoteness is derived in here (via `remoteKeyForRepo`), never at the
   * call site. A remote task launches its engine over SSH on the remote
   * host and spawns every pane in a local dir (the worktree is remote);
   * absent/local keeps today's behavior verbatim.
   */
  readonly repo?: string
  /**
   * Launch-time init/prompt contract for a FRESH session. The script is
   * woven before the engine in the same shell; the first message is pasted
   * after the engine is ready. No-op on pure reuse — only the create path
   * applies it. Resolve via {@link resolveEngineLaunchInit}.
   */
  readonly launchInit?: EngineLaunchInit
}

/** Per-session-name in-flight lock — concurrent enters coalesce. */
const ensureSessionLocks = new Map<string, Promise<boolean>>()

/**
 * Ensure a detached session named `name` exists with the four-pane
 * layout. Returns `true` once the session is ready (reused or freshly
 * built), `false` if creation failed (so callers can avoid attaching to
 * a nonexistent session — KOB-244).
 *
 * Idempotent in the happy path: a healthy session that matches this
 * task is left running (that's the persistence — it survives detach /
 * kobe restart). Otherwise it is **rebuilt** (killed + recreated); we
 * choose rebuild over in-place `split-window` because a stale/legacy
 * session's pane 0 already runs an engine with whatever state the user
 * has, and splitting now would only become "correct" after the next
 * restart anyway.
 *
 * Concurrent calls for the same `name` (e.g. a fast double-Enter) share
 * one build via {@link ensureSessionLocks} instead of racing
 * kill-session against each other's split-window.
 */
export async function ensureSession(opts: EnsureSessionOpts): Promise<boolean> {
  const inflight = ensureSessionLocks.get(opts.name)
  if (inflight) return inflight
  const work = ensureSessionImpl(opts)
  ensureSessionLocks.set(opts.name, work)
  try {
    return await work
  } finally {
    ensureSessionLocks.delete(opts.name)
  }
}

/**
 * `list-panes -s -F` format answering EVERY observe question in one tmux
 * spawn: `#{@kobe_worktree}` / `#{@kobe_vendor}` are session-scoped user
 * options, which tmux format expansion resolves from any pane of the
 * session (format lookup consults pane, window, session and global option
 * scopes — verified on tmux 3.5a); `window_active` scopes the
 * claude-pane-alive check to the session's current window, matching the
 * old `claudePaneIdStrict` (`list-panes` without `-s` lists the current
 * window's panes); distinct `window_id`s are the window count.
 */
const OBSERVE_SESSION_FORMAT = "#{window_id}\t#{window_active}\t#{@kobe_role}\t#{@kobe_worktree}\t#{@kobe_vendor}"

/** Parse `list-panes -F OBSERVE_SESSION_FORMAT` output. Pure, exported for tests. */
export function parseObservedSession(stdout: string): ObservedSession {
  let worktree = ""
  let vendor = ""
  let claudePaneAlive = false
  const windows = new Set<string>()
  for (const line of stdout.split("\n")) {
    const [windowId, active, role, wt, vd] = line.split("\t")
    if (!windowId?.trim()) continue
    windows.add(windowId.trim())
    if (!worktree && wt?.trim()) worktree = wt.trim()
    if (!vendor && vd?.trim()) vendor = vd.trim()
    if (active?.trim() === "1" && role?.trim() === "claude") claudePaneAlive = true
  }
  return { worktree, vendor, claudePaneAlive, windowCount: windows.size }
}

/**
 * Snapshot the facts about an existing session that the reuse/respawn/
 * rebuild decision needs (`null` when no session exists). All read-only
 * tmux queries live here; the policy that consumes them is the pure
 * `decideSessionAction` in `tmux/session-decision.ts`. Two tmux spawns:
 * the quiet existence probe, then ONE `list-panes -s` whose format
 * ({@link OBSERVE_SESSION_FORMAT}) carries the session options, the
 * active-window claude-pane check and the window count that previously
 * took three more spawns (`show-options` ×2 batched, `list-panes`,
 * `list-windows`). A listing that fails AFTER the existence probe (the
 * session vanished mid-observe) degrades to the same all-empty snapshot
 * the three independent failed queries used to produce — the decision
 * then rebuilds, exactly as before.
 */
async function observeSession(name: string): Promise<ObservedSession | null> {
  if (!(await sessionExists(name))) return null
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${name}`, "-F", OBSERVE_SESSION_FORMAT])
  if (code !== 0) return { worktree: "", vendor: "", claudePaneAlive: false, windowCount: 0 }
  return parseObservedSession(stdout)
}

/**
 * The vendor a live session is ACTUALLY running, from its `@kobe_vendor`
 * tag — `null` when no session exists (or it carries no tag). Lets a launcher
 * reconcile a task's persisted vendor to reality before `ensureSession`, so a
 * stale persisted vendor can't trigger a destructive `respawn-engine` of a
 * healthy engine pane (e.g. a main task frozen at "claude" wiping a running
 * codex session on restart).
 */
export async function observeSessionVendor(name: string): Promise<string | null> {
  const observed = await observeSession(name)
  const v = observed?.vendor.trim()
  return v ? v : null
}

async function ensureSessionImpl(opts: EnsureSessionOpts): Promise<boolean> {
  const launchInit = opts.launchInit
  // (Engine activity hooks are NOT installed here — they live in the user's
  // global ~/.claude/settings.json, installed once on launch by
  // `ensureGlobalKobeHooks`, and report their cwd so the daemon maps each event
  // to a task. No per-worktree write, so reuse/rebuild/fresh all behave the
  // same and a project's real repo root is never touched.)
  //
  // Observe → decide → apply. The WHY of each branch (KOB-244 pane-count
  // trap, KOB-232 sibling-tab preservation, legacy/pre-tag rebuilds) is
  // documented on `decideSessionAction`; this function only applies the
  // chosen action against the real tmux server.
  const observed = await observeSession(opts.name)
  const action = decideSessionAction(observed, {
    cwd: opts.cwd,
    vendor: opts.vendor,
    hasEngineCommand: opts.command.length > 0,
  })
  // The ONE remoteness derivation for this session build: a remote project's
  // key (`ssh://…`) or undefined for a local task. Everything below asks the
  // resolved host, never re-derives.
  const remoteKey = remoteKeyForRepo(opts.repo)

  // Reuse (healthy, or degraded multi-window — see the decision's reason):
  // leave the session running, just heal pane widths + stale kobe-owned
  // pane versions.
  if (action.kind === "reuse") {
    await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
    return true
  }

  // Vendor switch: relaunch the engine pane IN PLACE in every window via
  // respawn-pane (keeps pane ids + @kobe_role tags, so the Ops pane's
  // --target-pane stays valid — KOB-232). Falls through to a full rebuild
  // when no engine pane is found to respawn — that fact is only knowable
  // here at apply time, so it's the applier's fallback, not the decision's.
  if (action.kind === "respawn-engine") {
    const relaunch = await relaunchEngineInAllWindows(opts.name, opts.cwd, opts.command, remoteKey, opts.vendor)
    if (relaunch === "switched") {
      // Advance the session's `@kobe_vendor` tag ONLY now that every window's
      // engine pane respawned on the new vendor — the tag is a single
      // session-scoped fact the Ops panes (and `decideSessionAction`) trust to
      // describe what's actually running, so a partial respawn must not move it.
      if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)
      // `vendorChanged` forces every window's Ops pane to respawn so its baked
      // `--vendor` flag (and the transcript store its activity badge + turn
      // detector poll) tracks the NEW engine — a same-version Ops pane would
      // otherwise keep polling the OLD vendor's store (KOB-232).
      await healWorkspaceLayout(opts.name, {
        cwd: opts.cwd,
        taskId: opts.taskId,
        vendor: opts.vendor,
        vendorChanged: true,
      })
      return true
    }
    if (relaunch === "respawn-failed") {
      // A respawn in some window failed (tmux already logged the error and
      // halted the sequence). The session still exists and is usable, so we
      // do NOT kill+rebuild — that would drop the sibling chat tabs the
      // in-place respawn exists to preserve (KOB-232). We also leave the prior
      // `@kobe_vendor` tag untouched rather than falsely claim the switch; the
      // tag still mismatching the task's vendor means the next `ensureSession`
      // re-enters this respawn branch and retries. Heal layout WITHOUT
      // `vendorChanged` so the Ops panes stay aligned with the tag we kept.
      await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
      return true
    }
    // relaunch === "no-engine-pane" → fall through to the rebuild path below.
  }

  // Rebuild (or a respawn that found no engine pane): kill, then fall
  // through to the shared create path below.
  if (action.kind === "rebuild" || action.kind === "respawn-engine") {
    await killSession(opts.name)
  }

  // Create the session's first window with the claude pane, then build
  // the surrounding panes. Each pane command is passed as the trailing
  // arg to new-session / split-window — tmux runs it via its own
  // `sh -c`, so we hand it a single shell command STRING and skip
  // send-keys (which re-parses text and mangled the Ops `sh -c` quoting
  // in KOB-233). Pane ids (`%N`) are server-global and immune to
  // `base-index`, so we always target by id.
  const inv = kobeCliInvocation()
  // Force a known session id for a claude launch so this window can be mapped
  // to its transcript and auto-named from its first prompt (KOB). No-op for
  // codex/copilot or a command that already pins its session.
  const launch = withClaudeSessionId(opts.command, opts.vendor)
  // Status self-report protocol (web-kanban.md M5): bake this task's id into
  // the session's system prompt so the agent can move its own card to
  // in_review when done. No-op unless experimental.autoStatus is on.
  // Excluded: MAIN sessions (worktreePath === repo is the main-task
  // invariant — project rows aren't board cards, and main's status heal
  // doesn't cover a stray in_review) and REMOTE tasks (the protocol's
  // `kobe api` would run on the remote host, where this daemon isn't).
  const isMainSession = opts.repo !== undefined && opts.cwd === opts.repo
  const protocolTaskId = isMainSession || remoteKey ? undefined : opts.taskId
  // Dispatcher protocol (docs/design/dispatcher.md): the exact complement —
  // only a LOCAL MAIN session gets the dispatcher seat. The taskId gates are
  // mutually exclusive by construction, so at most one protocol injects.
  const dispatcherTaskId = isMainSession && !remoteKey ? opts.taskId : undefined
  const launchArgv = withDispatcherProtocol(
    withWorktreeProtocol(launch.argv, opts.vendor, protocolTaskId),
    opts.vendor,
    dispatcherTaskId,
  )
  // Remote task: the engine runs over SSH on the remote host (`ssh … 'cd <wt>
  // && <engine>'`), and the pane spawns in a LOCAL dir since the worktree is
  // remote. The repo's init script is deferred for remote (it runs locally
  // today — see docs/design/remote-projects.md phase 8), so it's skipped here.
  const engineCmd = wrapEngineLaunch(shellQuoteArgv(launchArgv), remoteKey, opts.cwd)
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    localSpawnCwd(opts.cwd),
    ...tmuxInitialSizeArgs(),
    "-P",
    "-F",
    "#{pane_id}",
    // Weave the per-repo init script before the engine (once-per-worktree
    // via a marker under <home>/.kobe/). Plain keepAlive when there's none.
    engineLaunchLine(engineCmd, {
      initScript: remoteKey ? undefined : launchInit?.initScript,
      markerPath: !remoteKey && launchInit?.initScript ? worktreeInitMarkerPath(opts.cwd) : undefined,
      // Operator escape hatch for an unusually slow (or fast-fail) init —
      // clamped + defaulted by the resolver; unset keeps the 120s default.
      timeoutSeconds: resolveRepoInitTimeoutSeconds(process.env.KOBE_REPO_INIT_TIMEOUT_SECONDS),
    }),
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return false
  }
  if (launch.sessionId) await setWindowOption(pane0, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)

  // Tag the session with the task id + worktree so `kobe new-chattab`
  // (the Ctrl+T handler) can rebuild the same workspace in a new window.
  await runTmuxSequence([
    ...(opts.taskId ? ([["set-option", "-t", opts.name, "@kobe_task", opts.taskId]] as const) : []),
    ["set-option", "-t", opts.name, "@kobe_worktree", opts.cwd],
    ...(opts.vendor ? ([["set-option", "-t", opts.name, "@kobe_vendor", opts.vendor]] as const) : []),
    ...(remoteKey ? ([["set-option", "-t", opts.name, REMOTE_KEY_OPTION, remoteKey]] as const) : []),
  ])

  // Size the window to the REAL terminal BEFORE splitting. When spawned from
  // inside a tmux pane (the Tasks-pane "open task" path), `new-session -x/-y`
  // above read this host's narrow pane stdout, so the window was born at the
  // rail width. Splitting at that tiny size bakes in a degenerate layout:
  // growing the window to the real client later (prepareWindowForSwitch) only
  // redistributes proportionally, so the fixed 32-cell rail balloons and every
  // pane ends up near-even (the "all panes the same size" cold-open bug). Fit
  // the still-detached window to the attached client's dims first so the splits
  // land at the right geometry. No-op outside tmux (direct.ts already created
  // the session at the real terminal size — process.stdout IS the terminal).
  if (process.env.TMUX) {
    const { sizeArgs } = await attachedWindowInfo()
    if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${opts.name}`, ...sizeArgs])
  }

  await buildPanesAround(pane0, {
    cwd: opts.cwd,
    taskId: opts.taskId,
    opsCommand: opts.opsCommand,
    inv,
    vendor: opts.vendor,
  })

  // Server-scoped niceties — done after the session is alive so the
  // server is definitely up. All `-g` options are idempotent so
  // calling them on every ensureSession is harmless.
  //
  // Status bar: ON (KOB-233). v0.5/KOB-225 hid it because there was
  // only one pane and it was pure noise. With three panes it's useful
  // — it tells the user they're inside a kobe-managed tmux session,
  // which pane/window is active, and how to get out. We explicitly
  // set `on` (not just "leave default") so a server that an older
  // kobe turned OFF flips back.
  //
  // The status/window bar content is set here, while its theme is applied
  // below by applyTmuxChromeTheme(). The `-L kobe` socket still loads the
  // user's `~/.tmux.conf`, but kobe owns visual chrome on its own isolated
  // socket so the bottom ChatTab switcher matches the active kobe theme.
  // The session name (`kobe-<task-id>`, shown via the user's default `#S`
  // in status-left) remains the only identity we impose on the left.
  //
  // status-right is set minimally: from inside the engine/shell
  // pane the user otherwise has zero on-screen hint for kobe's
  // escape-hatch chords (get back to Tasks, detach, new tab). We show
  // the most useful ones; `status-right-style` supplies the themed muted
  // foreground. Server-scoped on
  // the isolated `-L kobe` socket, so the user's real tmux status-right
  // is never touched.
  // Window-status format: a compact activity icon in each ChatTab label.
  // `monitor-activity` is tmux-native and means "this window produced
  // output since you last viewed it", which is the reliable signal we have
  // inside a pure tmux handover without scraping engine-specific prompts.
  // Mouse: ON. The Tasks pane's click-to-switch and the Ops FileTree's
  // click/scroll only work if tmux forwards mouse events to the pane's
  // app. Most configs already set this, but we force it on the `-L
  // kobe` socket so the feature doesn't depend on the user's config.
  // No-prefix Ctrl+Q is two-stage while the Tasks pane is visible: focus the
  // current window's Tasks pane, then detach back to the launching shell on a
  // second press from there. If Tasks is hidden, Ctrl+Q detaches directly since
  // there is no rail stage to land on.
  // No-prefix Ctrl+h/j/k/l move between panes directionally — the
  // vim-tmux-navigator convention — and are edge-guarded so they never
  // wrap (see focusBindCommand). (Ctrl+1/2/3 was tried first but
  // terminals can't encode Ctrl+<digit> without the kitty protocol, so
  // the bindings registered yet never fired — KOB-233.) Directional
  // keys DO produce distinct codes and are the tmux-idiomatic choice.
  // Server-scoped on the `-L kobe` socket so the user's own tmux is
  // untouched. Trade-off: this shadows readline Ctrl+k (kill-line) /
  // Ctrl+l (clear) inside the claude + shell panes; acceptable for the
  // pane-nav win, and the prefix (Ctrl+B arrows) still works too.
  // Ctrl+T opens a same-engine chat tab = a new window with its own
  // engine process (fresh conversation) + the same panes, on the same
  // worktree. Ctrl+Shift+T (when the terminal forwards it) and prefix T
  // prompt for a specific engine before creating the tab.
  // No-prefix Ctrl+[ / Ctrl+] mirror kobe's old self-rendered chat-tab
  // cycle, but now map directly to tmux windows inside the handover.
  // Ctrl+W restores the v0.5 close-tab affordance. It deliberately
  // refuses to close the final window: tmux treats that as killing the
  // whole task session, while the user intent here is "close this
  // ChatTab", not "destroy the Task handover". F2 restores the v0.5
  // rename-tab affordance as a native tmux window rename.
  // `kobe new-chattab` reads the session's @kobe_task / @kobe_worktree
  // tags so the binding only needs to pass the session name (which
  // tmux expands at fire time).
  // Bake kobe's env onto the run-shell chords too (same reason as the
  // pane commands — see inheritedEnvPrefix), so `new-chattab` /
  // `quick-create` spawn against the SAME home + daemon as this monitor.
  const envStr = inheritedEnvPrefix()
  const invStr = inv.map(shellQuote).join(" ")
  const newChatTabCommand = `${envStr}${invStr} new-chattab --session '#{session_name}'`
  const chooseEngineCommand = `${newChatTabCommand} --vendor '%%'`
  const chooseEngineTmuxCommand = `run-shell ${shellQuote(chooseEngineCommand)}`
  // Two-stage Ctrl+Q: `kobe focus-tasks` selects/restores the current window's
  // Tasks pane (the else branch of the if-shell below). The detach branch is
  // reached when focus is already on Tasks, or immediately when Tasks is hidden.
  const focusTasksCommand = `${envStr}${invStr} focus-tasks --session '#{session_name}' --window '#{window_id}'`
  const focusTasksTmuxCommand = `run-shell ${shellQuote(focusTasksCommand)}`
  const layoutCommand = (action: string): string =>
    `${envStr}${invStr} layout --session '#{session_name}' --window '#{window_id}' --action ${action}`
  const restoreTasksCommand = layoutCommand("tasks-restore")
  const restoreTasksTmuxCommand = `run-shell ${shellQuote(restoreTasksCommand)}`
  const closeChatTabCommand = layoutCommand("chat-tab-close")
  const closeChatTabTmuxCommand = `run-shell ${shellQuote(closeChatTabCommand)}`
  // Re-pin the layout whenever a window settles to a new size. The FIRST task
  // session is built before any client is attached, so tmux sizes its window to
  // a stale default and reflows every pane PROPORTIONALLY once `attach` lands
  // the real terminal size — blowing up the absolute-width Tasks rail. The reuse
  // path heals later switches, but the first attach had none, so the very first
  // view was off until the user switched once.
  //
  // The hook is `window-resized`, NOT `client-attached`: on attach with a size
  // change tmux fires `client-attached` BEFORE it resizes the window (so a heal
  // there runs against the OLD size and is immediately undone by the resize),
  // then `window-resized` AFTER the new size lands. Healing on `window-resized`
  // re-pins against the SETTLED size — and also covers a live terminal resize,
  // which reflows the rail the same way. `-b` runs it in the background so tmux
  // isn't blocked; `resize-pane` never changes the window size, so the heal
  // can't re-trigger the hook. `heal-layout` is a no-op for role-less sessions.
  const healLayoutCommand = `${envStr}${invStr} heal-layout --session '#{session_name}'`
  const healLayoutTmuxCommand = `run-shell -b ${shellQuote(healLayoutCommand)}`
  // `client-resized` companion to the `window-resized` heal. The pre-attach /
  // pre-switch `resize-window` flips the window to `manual` sizing, so a LIVE
  // terminal GROW no longer auto-resizes the window and `window-resized` never
  // fires for it — the UI stays letterboxed small until a task switch or reopen.
  // `client-resized` fires on every terminal size change regardless of the pin,
  // so we re-pin the window to the new client size (outer frame follows the
  // terminal) and heal the rail. Client dims are passed as ARGS: the detached
  // `-b` shell isn't attached to a client, so it can't read its own
  // `#{client_*}`. `resync-window` coalesces the drag's burst to one re-pin.
  const resyncWindowCommand = `${envStr}${invStr} resync-window --session '#{session_name}' --client '#{client_name}' --cols '#{client_width}' --rows '#{client_height}' --status '#{status}'`
  const resyncWindowTmuxCommand = `run-shell -b ${shellQuote(resyncWindowCommand)}`
  // Capture a manual rail / right-column drag the moment it happens, on
  // `window-layout-changed` (which fires on a pane resize, unlike
  // `window-resized`). Without this, a drag was only persisted into the global
  // on switch-away, so dragging the rail and THEN resizing the terminal lost
  // the drag — the resize's `window-resized` heal re-pinned every pane to the
  // STALE global before the drag was ever captured. `capture-layout` is gated
  // (resize-recency + not-zoomed + full role set) so it captures only genuine
  // drags, never a resize reflow or a half-built layout. Both hooks coalesce
  // their event bursts to one run (see layout-coord.ts).
  const captureLayoutCommand = `${envStr}${invStr} capture-layout --session '#{session_name}'`
  const captureLayoutTmuxCommand = `run-shell -b ${shellQuote(captureLayoutCommand)}`
  // `<prefix> u` = open a URL from the focused pane. iTerm2's Cmd+click reads the
  // RENDERED grid, so a URL that wraps at the (narrower-than-terminal) tmux pane
  // boundary is captured half-truncated. `capture-pane -J` joins the visual wrap
  // back into the full logical line, so the URL survives intact. `#{pane_id}`
  // expands at fire time → the pane that was focused, before the popup steals
  // active. fzf when present (filter/pick); else open the most-recent match.
  // BSD `xargs -I{}` runs nothing on empty input (no stray Finder on cancel/no-match).
  const openUrlTmuxCommand = openUrlCommand({ tmuxSocket: KOBE_TMUX_SOCKET })
  // Pane-aware drag-copy to the SYSTEM clipboard. `mouse on` (below) already
  // routes a plain left-drag into copy-mode, which selects WITHIN the focused
  // pane — the pane-aware behaviour we want. But tmux's default leaves that
  // selection only in its own paste buffer, so users fall back to the
  // terminal's native Option+drag, which bleeds the selection ACROSS panes.
  // `set-clipboard on` lets tmux push the selection to the terminal's
  // clipboard via OSC 52; when a local clipboard tool is present we ALSO pipe
  // the copy-mode "finish selection" actions straight to it (pbcopy / wl-copy
  // / xclip / xsel), covering the drag-release (`MouseDragEnd1Pane` — the exact
  // user flow) and keyboard copy (`y` / Enter), in BOTH the emacs and vi
  // copy-mode tables. A missing tool is graceful: we keep `set-clipboard on`
  // (OSC 52 only) and skip the copy-pipe bindings, never breaking session
  // creation. These are copy-mode-table bindings only, so a pane app that
  // grabs mouse events (its own selection) is unaffected.
  const clipboardCopyCommand = resolveClipboardCopyCommand(process.platform, clipboardBinaryOnPath)
  const clipboardBindings = clipboardTmuxConfig(clipboardCopyCommand)
  // `<prefix> f` = quick-create: open the prompt-only quick-task page (the
  // v0.5 quick-fork chord, KOB-74, reborn in the tmux world). `kobe
  // quick-create` opens `kobe quick-task` in its own window, which asks for
  // ONLY a prompt and fills repo / engine / base branch from this task's
  // defaults, then creates + delivers and exits. PREFIX-scoped (not no-prefix
  // C-f): a no-prefix Ctrl+F was unusable — it shadows readline
  // forward-char in the claude/shell panes and several apps grab it, so
  // the chord never reliably reached tmux. `<prefix> f` ("fork") is a
  // two-key chord but conflict-free; the prefix is whatever the user's
  // own tmux.conf sets (we load it on the `-L kobe` socket).
  // Multi-client sizing: a task session can have >1 client attached (two
  // `kobe` processes on the same task, or a detached big terminal + a fresh
  // small one). tmux's default sizes a window to the SMALLEST client of the
  // session regardless of which window that client is actually viewing — so a
  // small client on chat-tab B drags chat-tab A down for the big client too,
  // which then squeezes the fixed-width Tasks pane (KOB-248) against a too-narrow
  // window. `aggressive-resize on` scopes the size to the client(s) for which the
  // window is CURRENT, so each chat-tab window tracks only its own viewer.
  // Same-session clients still share one tmux grid; prepareWindowForAttach /
  // prepareWindowForSwitch mitigate that by marking already-attached clients
  // with conflicting terminal sizes as `ignore-size`, so passive monitors do not
  // letterbox the screen being actively entered. True independent same-window
  // sizes still require per-client sessions (a larger refactor, deferred).
  // Session keys come from the user-resolvable tmux key set (defaults
  // C-q / C-hjkl / C-t / C-S-T / C-[ / C-] / C-w / F2 plus prefix-scoped
  // layout keys; overridable via `~/.kobe/settings/keybindings.yaml`,
  // `tmux.*` ids). For every
  // OVERRIDDEN id we first unbind its DEFAULT key: the tmux server is
  // long-lived, so a previous run (or an older kobe) may have bound it —
  // without the unbind both the old and new chord would fire. We also always
  // unbind the short-lived F6-F11 layout defaults from 0.7.30 so an upgraded,
  // long-lived tmux server drops those root-table conflicts. Unbinding a
  // never-bound root/prefix key exits 0 silently, so this is safe on a fresh
  // server too. An id resolved to null installs nothing (user unbind).
  const userKeys = resolveUserTmuxKeys()
  const unbinds: (readonly string[])[] = TMUX_LEGACY_LAYOUT_ROOT_KEYS.map((key) => ["unbind-key", "-n", key])
  if (userKeys.overridden.has(TMUX_FOCUS_ID)) {
    for (const chord of TMUX_FOCUS_DEFAULTS) {
      const t = chordToTmuxKey(chord)
      if ("key" in t) unbinds.push(["unbind-key", "-n", t.key])
    }
  }
  for (const id of userKeys.overridden) {
    if (id === TMUX_FOCUS_ID) continue
    const def = TMUX_SINGLE_BINDING_DEFAULTS[id as keyof typeof TMUX_SINGLE_BINDING_DEFAULTS]
    const isPrefix = isTmuxPrefixBindingId(id)
    const t = chordToTmuxKey(def, { allowBare: isPrefix })
    if ("key" in t) unbinds.push(isPrefix ? ["unbind-key", t.key] : ["unbind-key", "-n", t.key])
  }
  const focusDirections: readonly FocusDirection[] = ["-L", "-D", "-U", "-R"]
  const focusBinds = userKeys.focus.flatMap((bind, i) => {
    const dir = focusDirections[i]
    const edgeCommand = dir === "-L" ? restoreTasksTmuxCommand : undefined
    return bind && dir ? [focusBindCommand(bind.key, dir, edgeCommand)] : []
  })
  const b = userKeys.binds
  const layoutBind = (id: keyof typeof b, action: string): (readonly string[])[] => {
    const bind = b[id]
    return bind ? ([["bind-key", bind.key, "run-shell", layoutCommand(action)]] as const) : []
  }
  const layoutChordGroup = (...ids: (keyof typeof b)[]): string | null => {
    const chords = ids.map((id) => b[id]?.chord).filter((chord): chord is string => !!chord)
    return chords.length > 0 ? chords.join("/") : null
  }
  await runTmuxSequence([
    ["set-option", "-g", "status", "on"],
    ["set-window-option", "-g", "aggressive-resize", "on"],
    ["set-option", "-g", "monitor-activity", "on"],
    ["set-option", "-g", "visual-activity", "off"],
    ["set-option", "-g", "window-status-format", CHAT_TAB_STATUS_FORMAT],
    ["set-option", "-g", "window-status-current-format", CHAT_TAB_STATUS_CURRENT_FORMAT],
    [
      "set-option",
      "-g",
      "status-right",
      kobeStatusRight({
        focusLeft: userKeys.focus[0]?.key ?? null,
        detach: b["tmux.detach"]?.key ?? null,
        newTab: b["tmux.tab.new"]?.key ?? null,
        layoutSplits: layoutChordGroup(
          "tmux.layout.workspaceSplit",
          "tmux.layout.workspaceClose",
          "tmux.layout.workspaceReset",
        ),
        layoutPanes: layoutChordGroup(
          "tmux.layout.tasksToggle",
          "tmux.layout.opsToggle",
          "tmux.layout.terminalToggle",
          "tmux.layout.zenToggle",
        ),
      }),
    ],
    ["set-option", "-g", "mouse", "on"],
    // Let a pane-aware copy-mode selection reach the system clipboard:
    // `set-clipboard on` (OSC 52 fallback, always) + copy-pipe bindings when a
    // local clipboard tool is available. See the comment on clipboardBindings.
    ...clipboardBindings,
    ["set-hook", "-g", "window-resized", healLayoutTmuxCommand],
    ["set-hook", "-g", "client-resized", resyncWindowTmuxCommand],
    ["set-hook", "-g", "window-layout-changed", captureLayoutTmuxCommand],
    ...unbinds,
    // Two-stage: on the Tasks pane → detach (the old exit); anywhere else →
    // focus the current window's Tasks pane first. `#{@kobe_role}` is the
    // active pane's role tag.
    ...(b["tmux.detach"]
      ? [
          [
            "bind-key",
            "-n",
            b["tmux.detach"].key,
            "if-shell",
            "-F",
            `#{?#{${HIDDEN_TASKS_PANE_OPTION}},1,#{==:#{@kobe_role},tasks}}`,
            "detach-client",
            focusTasksTmuxCommand,
          ] as const,
        ]
      : []),
    ...focusBinds,
    ...(b["tmux.tab.new"] ? [["bind-key", "-n", b["tmux.tab.new"].key, "run-shell", newChatTabCommand] as const] : []),
    ...(b["tmux.tab.chooseEngine"]
      ? chatTabChooseEngineBindings(b["tmux.tab.chooseEngine"].key).map(
          (binding) => [...binding, chooseEngineTmuxCommand] as const,
        )
      : []),
    ...(b["tmux.tab.prev"] && b["tmux.tab.next"]
      ? chatTabSwitchBindings(b["tmux.tab.prev"].key, b["tmux.tab.next"].key)
      : b["tmux.tab.prev"]
        ? [["bind-key", "-n", b["tmux.tab.prev"].key, "previous-window"] as const]
        : b["tmux.tab.next"]
          ? [["bind-key", "-n", b["tmux.tab.next"].key, "next-window"] as const]
          : []),
    ...(b["tmux.tab.close"] ? [chatTabCloseBinding(b["tmux.tab.close"].key, closeChatTabTmuxCommand)] : []),
    ...(b["tmux.tab.rename"] ? [chatTabRenameBinding(b["tmux.tab.rename"].key)] : []),
    ...layoutBind("tmux.layout.workspaceSplit", "workspace-split"),
    ...layoutBind("tmux.layout.workspaceClose", "workspace-close"),
    ...layoutBind("tmux.layout.workspaceReset", "workspace-reset"),
    ...layoutBind("tmux.layout.tasksToggle", "tasks-toggle"),
    ...layoutBind("tmux.layout.opsToggle", "ops-toggle"),
    ...layoutBind("tmux.layout.terminalToggle", "terminal-toggle"),
    ...layoutBind("tmux.layout.zenToggle", "zen-toggle"),
    ["bind-key", "f", "run-shell", `${envStr}${invStr} quick-create --session '#{session_name}'`],
    ["bind-key", "u", "display-popup", "-E", openUrlTmuxCommand],
  ])

  // Theme-matched tmux chrome. The tmux defaults (stock green status
  // bar, green active pane border, or a user's tmux.conf gray) clash
  // with kobe themes; derive the status/window bar, prompts, mode
  // selection, pane picker, and borders from the active theme instead.
  // Precedence + the off-switch live in tmux-border-theme.ts.
  await applyTmuxChromeTheme()

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])

  // First engine message: deliver it AFTER the engine wakes, on this
  // FRESH session only (this is the create path — reuse/respawn never
  // reach here). Fire-and-forget so building the session doesn't block on
  // the engine's boot; the helper waits for readiness then pastes.
  const firstMessage = launchInit?.firstMessage
  if (firstMessage) {
    void deliverFirstEngineMessage(opts.name, firstMessage).catch((err) =>
      console.error("[kobe tmux] first message delivery failed:", err),
    )
  }
  return true
}

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
  let tasksPane = await paneIdByRoleInWindow(session, "tasks", opts.windowId)
  if (!tasksPane) {
    await runLayoutAction(session, "tasks-restore", { windowId: opts.windowId })
    tasksPane = await paneIdByRoleInWindow(session, "tasks", opts.windowId)
  }
  if (!tasksPane) return ""
  await runTmux(["select-pane", "-t", tasksPane])
  return tasksPane
}
