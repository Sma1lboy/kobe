/**
 * Shared low-level tmux client (v0.6) — the single public entry point.
 *
 * kobe drives a dedicated tmux server on the `-L kobe` socket (isolated from
 * the user's own tmux). The session-lifecycle code (`tui/panes/terminal/tmux.ts`)
 * and the Ops pane's `send-keys` mention (`tui/ops/host.tsx`) all spoke to
 * that socket with their own copies of the socket name, the spawn helpers,
 * and — critically — the "resolve a pane by id, not `:0.0`" workaround.
 *
 * That workaround is load-bearing: most tmux configs set `base-index 1`, so
 * the first window/pane is `:1.1`, and any code that targeted `:0.0` silently
 * hit nothing (this burned hours on exactly this, twice). Centralising the
 * pane-id resolution here means the fix lives in one place.
 *
 * Layering (each internal to `src/tmux/` — import THIS module from outside):
 *   client-spawn.ts    socket + argv builders + run/capture wrappers
 *   client-options.ts  session/server options, geometry, pane-role tagging
 *   client-teardown.ts SIGTERM sweeps + session kills
 *   client-home.ts     the kobe-home fallback session
 * plus the pane I/O helpers (capture / send-keys / windows) defined below.
 */

import { setWindowOption } from "./client-options"
import { runTmux, runTmuxCapturing } from "./client-spawn"

export {
  KOBE_TMUX_SOCKET,
  attachArgv,
  currentSessionName,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  runTmuxSequenceCapturing,
  sessionExists,
  tmuxArgs,
  tmuxAvailable,
  tmuxCommandSequence,
  tmuxSessionName,
  windowCount,
} from "./client-spawn"
export {
  CHAT_TAB_SESSION_ID_OPTION,
  CLAUDE_ROLE_OPTION,
  PANE_ROLE_OPTION,
  claudePaneId,
  claudePaneIdStrict,
  getServerOption,
  getServerOptions,
  getSessionOption,
  getSessionOptions,
  globalTasksPaneWidth,
  paneIdByRole,
  readLayoutGeometry,
  setSessionOption,
  setWindowOption,
  tagClaudePane,
  tagPaneRole,
} from "./client-options"
export { killSession, termAllPaneGroups, termWindowPaneGroups } from "./client-teardown"
export { KOBE_HOME_SESSION, ensureFallbackSession, switchClientBeforeKill } from "./client-home"

/**
 * Capture the visible text of `paneId`. `lines` (optional) extends the
 * capture `lines` rows up into scrollback. Returns `""` on any error.
 *
 * We do NOT pass `-e`, so tmux strips ANSI escapes and the output is
 * plain text — kobe deliberately renders captures plain (opentui owns
 * the colours). A future caller that wants raw colour would have to
 * add `-e`.
 */
export async function capturePaneById(paneId: string, lines?: number): Promise<string> {
  if (!paneId) return ""
  const args = ["capture-pane", "-t", paneId, "-p"]
  if (typeof lines === "number" && lines > 0) args.push("-S", String(-lines))
  const { code, stdout } = await runTmuxCapturing(args)
  return code === 0 ? stdout : ""
}

/**
 * Send LITERAL text to a pane — the `-l` flag is load-bearing.
 *
 * Without `-l`, tmux re-parses each argument as a KEY NAME, so a token
 * equal to `Enter` / `Space` / `Tab` / `C-x` (or an injected file path
 * shaped like one) fires that key instead of being typed. With `-l` the
 * text is always typed verbatim; `--` ends flag parsing so text starting
 * with `-` isn't mistaken for a flag. To send an actual named
 * key (e.g. Enter to submit) use {@link sendKeyName}, not this.
 */
export async function sendKeys(target: string, text: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, "-l", "--", text])
}

/** Send a tmux KEY NAME (e.g. `Enter`, `C-c`) to a pane — NOT literal text. */
export async function sendKeyName(target: string, key: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, key])
}

/**
 * Window option marking a full-window "surface" page (settings / new-task /
 * update / quick-task / help). These windows are single-pane kobe pages, not
 * task workspaces, so the session-global no-prefix navigation chords (Ctrl+Q
 * back-to-tasks, Ctrl+[/] tab switch, Ctrl+T new tab) must NOT fire there —
 * they'd yank the user out of a half-filled dialog. The bindings / CLI
 * handlers read this option and no-op when it's set. See
 * {@link windowIsSurface} and `chatTabSwitchBindings`.
 */
export const SURFACE_WINDOW_OPTION = "@kobe_surface"

/**
 * Open a new window in `session` running `command` (via tmux's own
 * `sh -c`). Used for the full-width file/diff preview. `name` sets the
 * window's status-bar label. When `command` exits (e.g. the pager
 * quits), tmux closes the window and switches back to the previous one.
 */
export async function newWindow(
  session: string,
  opts: { cwd: string; command: string; name?: string; surface?: boolean },
): Promise<void> {
  const args = ["new-window", "-t", `=${session}`, "-c", opts.cwd]
  if (opts.name) args.push("-n", opts.name)
  if (opts.surface) {
    // Capture the new window's id (`-P -F`) so we can tag it precisely rather
    // than racing on "the active window" after creation.
    args.push("-P", "-F", "#{window_id}")
    args.push(opts.command)
    const { code, stdout } = await runTmuxCapturing(args)
    const windowId = stdout.trim()
    if (code === 0 && windowId) await setWindowOption(windowId, SURFACE_WINDOW_OPTION, "1")
    return
  }
  args.push(opts.command)
  await runTmux(args)
}

/**
 * True when `target` (a window id or session name — the latter resolves to the
 * session's active window) is a surface page tagged {@link SURFACE_WINDOW_OPTION}.
 * Used to suppress workspace navigation chords inside settings/new-task/etc.
 */
export async function windowIsSurface(target: string): Promise<boolean> {
  const { code, stdout } = await runTmuxCapturing([
    "display-message",
    "-t",
    target,
    "-p",
    `#{${SURFACE_WINDOW_OPTION}}`,
  ])
  return code === 0 && stdout.trim() === "1"
}
