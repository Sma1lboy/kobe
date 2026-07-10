/**
 * Option/state layer of the tmux client — session/server user options, the
 * persisted layout geometry, and the `@kobe_role` pane tagging + lookup that
 * every "find the claude/tasks pane again" path relies on. Internal to
 * `src/tmux/`; import via `./client.ts` from outside this directory.
 */

import { runTmux, runTmuxCapturing, runTmuxSequenceCapturing } from "./client-spawn"
import { LAYOUT_GEOMETRY_OPTIONS, type LayoutGeometry, resolveLayoutGeometry } from "./session-layout"

/**
 * Set a session-scoped user option (e.g. `@kobe_task`).
 *
 * NOTE: `set-option` / `show-options` do NOT accept the `=name`
 * exact-match prefix that most other tmux targets take — tmux 3.5a
 * treats `=name` as a literal session name and reports "no such
 * session", silently dropping the option (easy to lose a debug cycle
 * on exactly this). So these two helpers target the bare name. Our
 * session names are `kobe-<taskId>` slugs; a prefix collision between
 * two live tasks is the only theoretical risk and we accept it.
 */
export async function setSessionOption(session: string, option: string, value: string): Promise<void> {
  await runTmux(["set-option", "-t", session, option, value])
}

/**
 * Read a session-scoped user option. `""` when unset / session gone.
 *
 * The `-q` flag is load-bearing (same reason as {@link getServerOption}):
 * without it tmux *errors* on an unset user option (`invalid option:
 * @kobe_zen`, exit 1), which the capturing wrapper surfaces as a banner on
 * every poll before the option is first set. `-q` makes an unset option
 * resolve to an empty string with exit 0 instead.
 */
export async function getSessionOption(session: string, option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-qv", "-t", session, option])
  return code === 0 ? stdout.trim() : ""
}

/** Read several session-scoped user options in one tmux process. */
export async function getSessionOptions(
  session: string,
  options: readonly string[],
): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = Object.fromEntries(options.map((option) => [option, undefined]))
  const { code, stdout } = await runTmuxSequenceCapturing(
    options.map((option) => ["show-options", "-q", "-t", session, option]),
  )
  if (code !== 0) return values
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(" ")
    if (idx <= 0) continue
    const option = line.slice(0, idx)
    if (option in values) values[option] = line.slice(idx + 1).trim()
  }
  return values
}

/**
 * Read a server-scoped (global to the whole tmux server) user option. `""`
 * when unset. The `-q` flag is load-bearing: without it, tmux *errors* on an
 * unset user option (`invalid option: @kobe_…`, exit 1), which the capturing
 * wrapper logs as noise on every cold start before any preference is set. `-q`
 * makes an unset option resolve to an empty string with exit 0 instead. Server
 * scope is the natural home for a cross-task UI preference: one value shared by
 * every task session on the socket, outliving any single session. Set it with
 * `set-option -s`.
 */
export async function getServerOption(option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-sqv", option])
  return code === 0 ? stdout.trim() : ""
}

/**
 * Read several server-scoped options in ONE tmux process (the plural of
 * {@link getServerOption}, mirroring {@link getSessionOptions}). Each
 * command is `show-options -sq <opt>` WITHOUT `-v`, so a set option prints
 * a `<name> <value>` line we can attribute (with `-v` an unset `-q` option
 * prints nothing and the values couldn't be told apart). Unset options
 * resolve to `undefined`.
 */
export async function getServerOptions(options: readonly string[]): Promise<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = Object.fromEntries(options.map((option) => [option, undefined]))
  const { code, stdout } = await runTmuxSequenceCapturing(options.map((option) => ["show-options", "-sq", option]))
  if (code !== 0) return values
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf(" ")
    if (idx <= 0) continue
    const option = line.slice(0, idx)
    if (option in values) values[option] = line.slice(idx + 1).trim()
  }
  return values
}

/**
 * The user's GLOBAL Tasks-rail width in cells — one value shared by every task
 * session (server option `@kobe_tasks_width`), so the rail is the same width
 * in every task. Falls back to the convention default when unset/garbage.
 */
export async function globalTasksPaneWidth(): Promise<number> {
  return (await readLayoutGeometry()).tasksWidth
}

/**
 * IO wrapper over {@link resolveLayoutGeometry}: read the global `@kobe_*`
 * geometry options in ONE tmux spawn and resolve them. The single source every
 * geometry consumer (build / heal / layout toggles / rail width) reads through.
 */
export async function readLayoutGeometry(): Promise<LayoutGeometry> {
  return resolveLayoutGeometry(await getServerOptions(LAYOUT_GEOMETRY_OPTIONS))
}

/** Per-pane user option marking a pane's role (set by `ensureSession`). */
export const PANE_ROLE_OPTION = "@kobe_role"
/** Back-compat alias — older callers imported `CLAUDE_ROLE_OPTION`. */
export const CLAUDE_ROLE_OPTION = PANE_ROLE_OPTION
const CLAUDE_ROLE_VALUE = "claude"

/** Tag a pane with a role (`claude` / `tasks`) so it can be re-found later. */
export async function tagPaneRole(paneId: string, role: string): Promise<void> {
  await runTmux(["set-option", "-p", "-t", paneId, PANE_ROLE_OPTION, role])
}

/**
 * Window-scoped user option holding the engine session UUID that runs in
 * this ChatTab window (set at launch via claude's `--session-id`). Lets the
 * auto-namer map a window → its transcript → its first prompt. Readable as
 * the `#{@kobe_session_id}` format variable in `list-windows`.
 */
export const CHAT_TAB_SESSION_ID_OPTION = "@kobe_session_id"

/** Set a window-scoped user option, targeting any pane/window inside it. */
export async function setWindowOption(target: string, option: string, value: string): Promise<void> {
  await runTmux(["set-window-option", "-t", target, option, value])
}

/** Tag a pane as the claude pane so {@link claudePaneId} can find it. */
export async function tagClaudePane(paneId: string): Promise<void> {
  await tagPaneRole(paneId, CLAUDE_ROLE_VALUE)
}

/**
 * The id of the pane tagged `role` in the session's ACTIVE window,
 * found by its `@kobe_role` user-option tag — robust against tmux's
 * by-position pane numbering (a left-hand Tasks pane renumbers
 * everything). `fallbackFirst` returns the first pane when no tagged
 * pane is found (used by claude for pre-tagging sessions). `""` when
 * the session doesn't exist.
 */
export async function paneIdByRole(sessionName: string, role: string, fallbackFirst = false): Promise<string> {
  // No `-s`: scope to the session's ACTIVE window (each chat-tab window
  // has its own claude / tasks pane).
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-t",
    `=${sessionName}`,
    "-F",
    `#{pane_id}\t#{${PANE_ROLE_OPTION}}`,
  ])
  if (code !== 0) return ""
  let firstId = ""
  for (const line of stdout.split("\n")) {
    const [id, paneRole] = line.split("\t")
    if (!id) continue
    if (!firstId) firstId = id.trim()
    if (paneRole?.trim() === role) return id.trim()
  }
  return fallbackFirst ? firstId : ""
}

/** The session's claude pane id (falls back to first pane). `""` if gone. */
export async function claudePaneId(sessionName: string): Promise<string> {
  return paneIdByRole(sessionName, CLAUDE_ROLE_VALUE, true)
}

/**
 * STRICT claude-pane lookup: the id of the pane explicitly tagged
 * `@kobe_role=claude` in the active window, with NO first-pane fallback.
 * `""` when the active window has no tagged claude pane — which is the
 * health signal {@link ../tui/panes/terminal/tmux.ts ensureSession} keys
 * its reuse decision on: a legacy/pre-tag (v0.5) session has no tagged
 * claude pane, so this returns `""` and the session is rebuilt, while a
 * healthy session whose disposable shell/ops pane was closed still has
 * its tagged claude pane and is reused.
 */
export async function claudePaneIdStrict(sessionName: string): Promise<string> {
  return paneIdByRole(sessionName, CLAUDE_ROLE_VALUE, false)
}
