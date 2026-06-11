/**
 * ChatTab lifecycle for a task's tmux session.
 *
 * A **chat tab** is a tmux window: an independent engine conversation on
 * the same worktree, carrying the same four-pane workspace (see the
 * `tmux.ts` header for the layout). This module owns everything that is
 * "a window in the session" rather than "the session build itself":
 *
 *   - the window-list presentation (`CHAT_TAB_STATUS_*` formats, the
 *     `@kobe_tab_state` activity tag, the muted `status-right` hint), and
 *     the chat-tab key-binding builders the `ensureSession` applier
 *     installs (`chatTab*Binding(s)` — KEY halves come from the
 *     user-resolvable tmux key set, COMMAND halves are fixed here);
 *   - {@link buildPanesAround} — the workspace panes built around a fresh
 *     engine pane, shared by the session's first window (`ensureSession`)
 *     and every new chat-tab window;
 *   - {@link newChatTab} (the Ctrl+T / engine-choice handler) and the
 *     dedicated single-page windows that sit alongside engine tabs:
 *     {@link openSettingsTab}, {@link openNewTaskTab},
 *     {@link openUpdateTab}, {@link quickCreate}.
 *
 * The session-level applier (`ensureSession`) stays in `tmux.ts`, which
 * re-exports this module's public surface so callers keep their
 * `panes/terminal/tmux` import path.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { localSpawnCwd } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  getSessionOptions,
  globalTasksPaneWidth,
  newWindow,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  runTmuxSequenceCapturing,
  sessionExists,
  setSessionOption,
  setWindowOption,
} from "@/tmux/client"
import {
  CLAUDE_PANE_PERCENT,
  OPS_PANE_PERCENT,
  keepAlive,
  opsPaneCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
  updatePageCommand,
} from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"
import { ALL_VENDORS } from "@/types/vendor"
import { CURRENT_VERSION } from "@/version"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { PANE_VERSION_OPTION, globalRightColumnResizeArgs } from "./pane-heal"

// ChatTab binding builders. The KEY argument comes from the user-
// resolvable tmux key set (`resolveUserTmuxKeys` — defaults C-[ / C-] /
// C-w / F2); the COMMAND halves are fixed. Builders instead of consts so
// `~/.kobe/settings/keybindings.yaml` overrides flow through one place.
export function chatTabSwitchBindings(prevKey: string, nextKey: string) {
  return [
    ["bind-key", "-n", prevKey, "previous-window"],
    ["bind-key", "-n", nextKey, "next-window"],
  ] as const
}

export function chatTabCloseBinding(key: string) {
  return [
    "bind-key",
    "-n",
    key,
    "if-shell",
    "-F",
    "#{>:#{session_windows},1}",
    "kill-window",
    "display-message 'Cannot close the only ChatTab'",
  ] as const
}

export function chatTabRenameBinding(key: string) {
  return ["bind-key", "-n", key, "command-prompt", "-I", "#{window_name}", "rename-window -- '%%'"] as const
}

// The prompt names the built-ins as examples but ends with `…` so it doesn't
// imply a CLOSED list — users can register custom engines (Settings → Engines),
// and typing a registered custom id here is accepted (validated against
// `availableEngineIds()` in the `new-chattab` handler).
export const CHAT_TAB_ENGINE_PROMPT = `engine (${ALL_VENDORS.join("/")}/…)`

// Engine-choice ChatTab bindings: the no-prefix chord is user-resolvable
// (default C-S-T); the `prefix T` fallback row stays fixed — it exists
// precisely for terminals that can't forward the shifted control chord.
export function chatTabChooseEngineBindings(key: string) {
  return [
    ["bind-key", "-n", key, "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
    ["bind-key", "T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
  ] as const
}

/** Compact display form of a tmux key for the status-right hint (`C-h` → `^h`). */
function tmuxKeyCap(key: string): string {
  return key.startsWith("C-") && key.length === 3 ? `^${key.slice(2)}` : key
}

/**
 * Minimal, muted `status-right` shown on the `-L kobe` socket. From inside the
 * engine/shell pane the user has no other on-screen hint for kobe's
 * escape-hatch chords, so we surface the three most useful ones. `^h` (the
 * focus-left key) returns to the Tasks pane (the two-stage Ctrl+Q first stage
 * is reachable from there), `^q` is the two-stage detach, `^t` opens a new
 * chat tab. Built from the RESOLVED key set so user overrides show their own
 * chords; an unbound key drops its segment. Dimmed with `fg=brightblack` so it
 * reads as a muted hint rather than fighting the user's theme; the trailing
 * space keeps it off the terminal's right edge.
 */
export function kobeStatusRight(keys: {
  focusLeft: string | null
  detach: string | null
  newTab: string | null
}): string {
  const segments = [
    keys.focusLeft ? `${tmuxKeyCap(keys.focusLeft)} tasks` : null,
    keys.detach ? `${tmuxKeyCap(keys.detach)} detach` : null,
    keys.newTab ? `${tmuxKeyCap(keys.newTab)} tab` : null,
  ].filter((s): s is string => s !== null)
  return `#[fg=brightblack]${segments.join("  ")} `
}

export const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"
export const CHAT_TAB_STATUS_FORMAT =
  "#{?#{==:#{@kobe_tab_state},running},●,#{?#{==:#{@kobe_tab_state},done},✓,#{?#{==:#{@kobe_tab_state},error},!,#{?#{==:#{@kobe_tab_state},unknown},?,○}}}} #I:#W"
export const CHAT_TAB_STATUS_CURRENT_FORMAT = CHAT_TAB_STATUS_FORMAT

/**
 * Build the workspace panes around a freshly-created claude pane:
 * Tasks (left) + Ops (right-top) + shell (right-bottom). Shared by
 * the session's first window (`ensureSession` in `tmux.ts`) and every
 * new chat-tab window ({@link newChatTab}).
 */
export async function buildPanesAround(
  claudePane: string,
  args: { cwd: string; taskId?: string; opsCommand?: string; inv: readonly string[]; vendor?: string },
): Promise<void> {
  // Tag claude by a pane user-option — tmux renumbers panes by
  // position when the Tasks pane is inserted on the left, so the
  // monitor can't rely on "first pane" to find claude (KOB-233).
  const envPrefix = inheritedEnvPrefix()
  // Build the rail at the user's global width so a brand-new task/chat tab
  // matches the size every existing task already shows (consistency across
  // switches).
  const tasksWidth = await globalTasksPaneWidth()

  // Tasks pane to the LEFT (`-hb` inserts before). Task list that
  // switch-clients between task sessions + creates tasks. Tagged
  // `@kobe_role=tasks` so the Ctrl+F quick-create handler can re-find
  // it regardless of tmux's by-position pane numbering.
  const opsCmd = keepAlive(
    args.opsCommand ??
      envPrefix +
        opsPaneCommand({
          cwd: args.cwd,
          taskId: args.taskId,
          claudePaneId: claudePane,
          cliInvocation: args.inv,
          vendor: args.vendor,
        }),
  )

  // Ops pane (right column). Uses the claude pane id as its
  // `--target-pane` for `@file` mention injection.
  const { stdout } = await runTmuxSequenceCapturing([
    ["set-option", "-p", "-t", claudePane, "@kobe_role", "claude"],
    ["set-window-option", "-t", claudePane, CHAT_TAB_STATE_OPTION, "idle"],
    [
      "split-window",
      "-h",
      "-b",
      "-t",
      claudePane,
      "-l",
      // Fixed cell width (no `%`) so the Tasks rail is the same size in every
      // window + across engine rebuilds (KOB-248). The width is the user's
      // global preference, applied uniformly so every task shows one size.
      `${tasksWidth}`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "tasks=#{pane_id}",
      keepAlive(envPrefix + tasksPaneCommand(args.inv, { initialTaskId: args.taskId })),
    ],
    [
      "split-window",
      "-h",
      "-t",
      claudePane,
      "-l",
      `${100 - CLAUDE_PANE_PERCENT}%`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "ops=#{pane_id}",
      opsCmd,
    ],
    ["split-window", "-v", "-l", `${100 - OPS_PANE_PERCENT}%`, "-c", localSpawnCwd(args.cwd)],
    ["select-pane", "-t", claudePane],
  ])
  const ids = Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("=", 2)),
  )
  await runTmuxSequence([
    ...(ids.tasks ? ([["set-option", "-p", "-t", ids.tasks, "@kobe_role", "tasks"]] as const) : []),
    ...(ids.tasks ? ([["set-option", "-p", "-t", ids.tasks, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, "@kobe_role", "ops"]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
  ])

  // Override the default %-split with the user's global right-column geometry
  // (if any) so a freshly built window — first window or a new Ctrl+T chat tab
  // — matches the column shape every existing task already shows.
  if (ids.ops) {
    const rcArgs = await globalRightColumnResizeArgs()
    if (rcArgs.length > 0) await runTmux(["resize-pane", "-t", ids.ops, ...rcArgs])
  }
}

/**
 * Open a new chat-tab window in an existing task session: a new
 * tmux window with a fresh engine conversation + the same workspace
 * panes, on the same worktree. Invoked by `kobe new-chattab` (the
 * Ctrl+T handler), which passes only the session name for the fast path;
 * the worktree + task id + vendor are read back from the session's
 * `@kobe_*` tags so the new tab launches the SAME engine the task was
 * created with. The engine-prompt path passes `vendorOverride`.
 */
export async function newChatTab(session: string, vendorOverride?: VendorId): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, [
    "@kobe_worktree",
    "@kobe_task",
    "@kobe_vendor",
    REMOTE_KEY_OPTION,
  ])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const remoteKey = sessionOptions[REMOTE_KEY_OPTION] || undefined
  const vendor = vendorOverride ?? (sessionOptions["@kobe_vendor"] as VendorId | undefined)
  if (vendorOverride) await rememberSessionVendor(session, taskId, vendorOverride)
  const command = interactiveEngineCommand(vendor)
  // Same forced-session-id mapping as the first window, so a Ctrl+T tab is
  // auto-named from its OWN first prompt (KOB).
  const launch = withClaudeSessionId(command, vendor)
  const inv = kobeCliInvocation()
  const r = await runTmuxCapturing([
    "new-window",
    "-t",
    `=${session}`,
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    // Re-wrap the engine over SSH for a remote task's chat tab (same engine the
    // task launched with), reusing the project's ControlMaster connection.
    keepAlive(wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd)),
  ])
  const claudePane = r.stdout.trim()
  if (!claudePane) return
  if (launch.sessionId) await setWindowOption(claudePane, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)
  await buildPanesAround(claudePane, { cwd, taskId, inv, vendor })
}

/**
 * Open the Settings page as a dedicated chat-tab window in an existing
 * task session (the default settings surface — see settings-surface.ts).
 * A single full-window `kobe settings` page (no engine, no workspace
 * panes), sitting alongside the engine chat tabs in the status-bar
 * window list. It is NOT `keepAlive`-wrapped: when the user closes
 * Settings (q / esc), the page process exits, tmux closes the window and
 * switches back to the previous tab. The `@kobe_*` tags aren't needed —
 * the page only reads/writes shared kv state, not a worktree.
 */
export async function openSettingsTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} settings`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "settings" })
}

/**
 * Open the F1 keybindings help as a dedicated chat-tab window in an
 * existing task session (mirroring {@link openSettingsTab}). A single
 * full-window `kobe help-page` — the in-pane HelpDialog overlay only had
 * the narrow Tasks rail to render in, which truncated every row. Not
 * `keepAlive`-wrapped: closing the page (q / esc / F1) exits the process,
 * tmux closes the window and returns to the previous tab.
 */
export async function openHelpTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} help-page`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "help" })
}

/**
 * Open the new-task flow as a dedicated chat-tab window in an existing
 * task session (the `chattab` settings surface, mirroring
 * {@link openSettingsTab}). A single full-window `kobe new-task` page
 * that performs the create/adopt itself and exits — tmux then closes the
 * window and returns to the previous tab. `defaultRepo` pre-selects the
 * repo picker (the Tasks pane's cursor-task repo); the page falls back to
 * the first saved repo / cwd when it's omitted.
 */
export async function openNewTaskTab(session: string, defaultRepo?: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const repoArg = defaultRepo ? ` --repo ${shellQuote(defaultRepo)}` : ""
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} new-task${repoArg}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "new task" })
}

/**
 * Open update details as a dedicated tmux window. The Tasks pane footer
 * stays compact; the full page owns release notes, clickable actions,
 * and the terminal handoff for actually running the updater.
 */
export async function openUpdateTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${updatePageCommand({ cliInvocation: inv })}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "update" })
}

/**
 * Quick-create (`<prefix> f`): open the prompt-only quick-task page as a
 * dedicated chat-tab window (mirroring {@link openNewTaskTab}). The page
 * (`kobe quick-task`) asks for ONLY a prompt and fills repo / engine / base
 * branch from defaults derived from this session's task, then creates the
 * task + delivers the prompt and exits. Invoked by `kobe quick-create`,
 * which passes only the session name.
 */
export async function quickCreate(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} quick-task --session ${shellQuote(session)}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "quick task" })
}

/**
 * Engine-choice ChatTab creation is also a default change: after the user
 * picks a vendor, future Ctrl+T tabs should use that vendor without asking.
 * Persist both the tmux session tag (immediate fast path) and the daemon's
 * task record (so the next ensureSession does not relaunch back to the old
 * task vendor).
 */
async function rememberSessionVendor(session: string, taskId: string | undefined, vendor: VendorId): Promise<void> {
  await setSessionOption(session, "@kobe_vendor", vendor)
  if (!taskId) return
  try {
    const { connectOrStartDaemon } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
    const client = await connectOrStartDaemon()
    try {
      await client.request("task.setVendor", { taskId, vendor })
    } finally {
      client.close()
    }
  } catch (err) {
    console.error("[kobe tmux] failed to persist selected engine vendor:", err)
  }
}
