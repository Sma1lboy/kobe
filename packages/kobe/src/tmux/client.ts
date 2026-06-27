/**
 * Shared low-level tmux client (v0.6 / KOB-233).
 *
 * kobe drives a dedicated tmux server on the `-L kobe` socket
 * (isolated from the user's own tmux). The session-lifecycle code
 * (`tui/panes/terminal/tmux.ts`) and the Ops pane's `send-keys` mention
 * (`tui/ops/host.tsx`) all spoke to that socket with their own copies
 * of the socket name, the spawn helpers, and — critically — the
 * "resolve a pane by id, not `:0.0`" workaround.
 *
 * That workaround is load-bearing: most tmux configs set
 * `base-index 1`, so the first window/pane is `:1.1`, and any code
 * that targeted `:0.0` silently hit nothing (KOB-233 burned hours on
 * exactly this, twice). Centralising the pane-id resolution here means
 * the fix lives in one place.
 */

import { homedir } from "node:os"
import { kobeCliInvocation } from "@/cli/invocation"
// `inheritedEnvPrefix` lives in the `panes/terminal/launch` helper module. That
// module's only deps are `@/exec/resolve` + `@/tmux/session-layout`, neither of
// which imports this file, so the reference is acyclic at runtime even though it
// reaches "up" into the tui layer — the import is for the kobe-home Tasks pane's
// env pinning below (KOB-244). Keeping the prefix in one place avoids re-deriving
// the same KOBE_*-pinning logic the workspace panes already use.
import { inheritedEnvPrefix } from "@/tui/panes/terminal/launch"
import {
  TASKS_PANE_WIDTH,
  TASKS_WIDTH_OPTION,
  clampTasksPaneWidth,
  hiddenTerminalSessionName,
  homeWelcomeCommand,
  keepAlive,
  tasksPaneCommand,
} from "./session-layout"

/**
 * Dedicated tmux socket name — isolates kobe's server from the user's,
 * AND isolates kobe environments from each other.
 *
 * Read from `KOBE_TMUX_SOCKET` (default `kobe`). The dev scripts set a
 * distinct value per environment (`dev:sandbox` → `kobe-sandbox`) so a
 * sandbox session never shares a server with production: `kill-server`,
 * `capture-pane`, and `list-sessions` are all naturally scoped to one
 * environment. This mirrors the existing per-`KOBE_HOME_DIR` daemon
 * socket isolation. Read once at module load — the env is fixed by the
 * launching shell before the process (or any child it spawns, including
 * the detached daemon and the tmux server's `run-shell` handlers, which
 * inherit it) starts.
 */
export const KOBE_TMUX_SOCKET = process.env.KOBE_TMUX_SOCKET?.trim() || "kobe"

/** Build a full `tmux -L kobe …` argv. */
export function tmuxArgs(...args: string[]): string[] {
  return ["tmux", "-L", KOBE_TMUX_SOCKET, ...args]
}

/**
 * tmux session name for a task. tmux disallows `.` and `:` in names
 * and matches a bare `-t name` as a prefix; we sanitize and always
 * target with `-t =name` (exact) at the call sites.
 */
export function tmuxSessionName(taskId: string): string {
  return `kobe-${taskId.replace(/[^A-Za-z0-9_-]/g, "")}`
}

/** argv that attaches to `name` (exact match). */
export function attachArgv(name: string): string[] {
  return tmuxArgs("attach-session", "-t", `=${name}`)
}

/** Read a child stream to a string, best-effort (`""` on any error). */
async function drainText(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return ""
  try {
    return await new Response(stream).text()
  } catch {
    return ""
  }
}

/**
 * cwd for every tmux child spawn — a directory guaranteed to outlive any
 * task's worktree.
 *
 * Each Tasks/Ops pane runs with its task's worktree as the process cwd.
 * Deleting a task unlinks that worktree, after which `Bun.spawn` fails
 * with `posix_spawn` ENOENT BEFORE the command runs — even though tmux is
 * on PATH — because the kernel can't resolve the inherited (now-gone)
 * cwd. That ENOENT used to throw straight into a pane's opentui loop and
 * crash the whole pane to a bare shell when its task was deleted.
 * Anchoring to `$HOME` (→ `/` if unset) keeps the helpers spawnable from
 * a pane whose worktree just vanished. Read once — `$HOME` is fixed for
 * the process lifetime.
 */
const SAFE_SPAWN_CWD = homedir() || "/"

/**
 * Run a tmux command, logging stderr when it fails. Silent tmux
 * errors are a foot-gun (KOB-233): a `split-window -t :0.0` that
 * failed because of `base-index 1` left the layout broken with no
 * trace. We only emit on a non-zero exit.
 *
 * stderr is drained CONCURRENTLY with the exit (not after it): if a
 * tmux invocation ever filled the stderr pipe buffer before exiting,
 * reading it only post-exit would dead-lock (the child blocks on the
 * write, we block on `exited`). tmux diagnostics are tiny in practice,
 * but the concurrent read removes the latent hang regardless (KOB-244).
 */
export async function runTmux(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "pipe",
    })
    const [errText, code] = await Promise.all([drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return code
  } catch {
    // posix_spawn itself failed (e.g. the pane's worktree cwd was just
    // deleted, or fd exhaustion). Degrade to a non-zero result so callers
    // running in a crash-net-less pane process see a failed command
    // instead of an unhandled rejection that kills the pane.
    return 1
  }
}

/** Run a tmux command without logging failures. Use only for existence probes. */
async function runTmuxQuiet(args: string[]): Promise<number> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), {
      stdin: "ignore",
      cwd: SAFE_SPAWN_CWD,
      stdout: "ignore",
      stderr: "ignore",
    })
    return await proc.exited
  } catch {
    return 1
  }
}

/** Flatten several tmux commands into one `tmux cmd \; cmd ...` invocation. */
export function tmuxCommandSequence(commands: readonly (readonly string[])[]): string[] {
  const out: string[] = []
  for (const cmd of commands) {
    if (cmd.length === 0) continue
    if (out.length > 0) out.push(";")
    out.push(...cmd)
  }
  return out
}

/** Run several tmux commands in one process. */
export async function runTmuxSequence(commands: readonly (readonly string[])[]): Promise<number> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? 0 : runTmux(args)
}

/**
 * Run a tmux command and capture stdout (stderr logged on failure).
 * Both streams are drained concurrently with the exit so neither a full
 * stdout (large capture-pane) nor a full stderr can dead-lock the call
 * (KOB-244).
 */
export async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "pipe", stderr: "pipe" })
    const [stdout, errText, code] = await Promise.all([drainText(proc.stdout), drainText(proc.stderr), proc.exited])
    if (code !== 0 && errText.trim().length > 0) {
      console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    }
    return { code, stdout }
  } catch {
    // See runTmux: a posix_spawn failure (deleted-worktree cwd, fd
    // exhaustion) degrades to an empty, non-zero capture rather than
    // throwing into a polling loop and crashing the pane. capturePaneById
    // already treats a non-zero code as `""`.
    return { code: 1, stdout: "" }
  }
}

/** Run several tmux commands in one process and capture combined stdout. */
export async function runTmuxSequenceCapturing(
  commands: readonly (readonly string[])[],
): Promise<{ code: number; stdout: string }> {
  const args = tmuxCommandSequence(commands)
  return args.length === 0 ? { code: 0, stdout: "" } : runTmuxCapturing(args)
}

/** Is the `tmux` binary on PATH? */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdin: "ignore", cwd: SAFE_SPAWN_CWD, stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/** Does a session with this exact name exist on kobe's socket? */
export async function sessionExists(name: string): Promise<boolean> {
  return (await runTmuxQuiet(["has-session", "-t", `=${name}`])) === 0
}

/**
 * Number of windows (chat tabs) in the session. `0` when the session
 * doesn't exist. Used to avoid a whole-session rebuild that would drop
 * sibling Ctrl+T chat-tab windows (KOB-244).
 */
export async function windowCount(sessionName: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-windows", "-t", `=${sessionName}`, "-F", "#{window_id}"])
  if (code !== 0) return 0
  return stdout.split("\n").filter((l) => l.trim().length > 0).length
}

/**
 * Set a session-scoped user option (e.g. `@kobe_task`).
 *
 * NOTE: `set-option` / `show-options` do NOT accept the `=name`
 * exact-match prefix that most other tmux targets take — tmux 3.5a
 * treats `=name` as a literal session name and reports "no such
 * session", silently dropping the option (KOB-233 burned a debug cycle
 * on exactly this). So these two helpers target the bare name. Our
 * session names are `kobe-<taskId>` slugs; a prefix collision between
 * two live tasks is the only theoretical risk and we accept it.
 */
export async function setSessionOption(session: string, option: string, value: string): Promise<void> {
  await runTmux(["set-option", "-t", session, option, value])
}

/** Read a session-scoped user option. `""` when unset / session gone. */
export async function getSessionOption(session: string, option: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing(["show-options", "-v", "-t", session, option])
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
 * session (server option {@link TASKS_WIDTH_OPTION}), so the rail is the same
 * width in every task. Falls back to the convention default when unset/garbage.
 */
export async function globalTasksPaneWidth(): Promise<number> {
  const raw = await getServerOption(TASKS_WIDTH_OPTION)
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? clampTasksPaneWidth(n) : TASKS_PANE_WIDTH
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
 * its tagged claude pane and is reused (KOB-244).
 */
export async function claudePaneIdStrict(sessionName: string): Promise<string> {
  return paneIdByRole(sessionName, CLAUDE_ROLE_VALUE, false)
}

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
 * with `-` isn't mistaken for a flag (KOB-244). To send an actual named
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
 * Open a new window in `session` running `command` (via tmux's own
 * `sh -c`). Used for the full-width file/diff preview. `name` sets the
 * window's status-bar label. When `command` exits (e.g. the pager
 * quits), tmux closes the window and switches back to the previous one.
 */
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

/**
 * The session this process is running inside, resolved from `$TMUX_PANE`
 * (set by tmux for every pane command). Returns `null` when we're not in
 * a kobe tmux pane (e.g. the outer monitor) or tmux can't answer — the
 * caller then falls back to the in-pane dialog surface.
 */
export async function currentSessionName(): Promise<string | null> {
  const args = ["display-message", "-p"]
  const target = process.env.TMUX_PANE
  if (target && target.length > 0) args.push("-t", target)
  args.push("#{session_name}")
  const { code, stdout } = await runTmuxCapturing(args)
  const name = stdout.trim()
  return code === 0 && name.length > 0 ? name : null
}

/** Kill a session (if any). */
export async function killSession(name: string): Promise<void> {
  if (!name.startsWith("kobe-hidden-")) {
    const hidden = hiddenTerminalSessionName(name)
    if (await sessionExists(hidden)) await runTmux(["kill-session", "-t", `=${hidden}`])
  }
  if (await sessionExists(name)) await runTmux(["kill-session", "-t", `=${name}`])
}

/** Session name for the kobe home window shown when a task is archived/deleted. */
export const KOBE_HOME_SESSION = "kobe-home"

/** Session option tagging a kobe-home built as the full Tasks home. */
const HOME_KIND_OPTION = "@kobe_home"

/**
 * Ensure the kobe-home session exists and return its name.
 *
 * kobe-home is where a client lands when the task it was attached to is
 * deleted/archived with no other task preferred ({@link switchClientBeforeKill}),
 * and where `kobe` parks when launched with zero tasks. It runs the same
 * full-width Tasks pane (`kobe tasks`) a real task session uses for its
 * sidebar, so the user can create (`n`) or pick a task and switch straight
 * into it — instead of being stranded on a dead-end placeholder shell (the
 * pre-fix behaviour: a bare `sh` printing "No active task").
 *
 * It keeps the product's layout frame: a welcome "no task" main pane with
 * the same fixed-width ({@link TASKS_PANE_WIDTH}) Tasks rail a real session
 * carries on its left, focused so `n`/arrows work immediately. The other
 * task-bound panes (engine chat, file tree, Ops) are omitted — they have no
 * worktree/engine to populate until a task is entered.
 *
 * cwd is anchored to {@link SAFE_SPAWN_CWD} (no worktree exists here); both
 * panes keep-alive so a returning command drops to a shell instead of
 * collapsing the window. A legacy placeholder home (missing the
 * `@kobe_home` tag) is rebuilt in place — tmux sessions outlive a kobe
 * relaunch, so a stale bare-shell home from an older build is upgraded
 * rather than silently reused. Safe to rebuild: this is only called before
 * switching a client ONTO home, never while one is parked on it.
 */
export async function ensureFallbackSession(): Promise<string> {
  const name = KOBE_HOME_SESSION
  if (await sessionExists(name)) {
    if ((await getSessionOption(name, HOME_KIND_OPTION)) === "tasks") return name
    await runTmux(["kill-session", "-t", `=${name}`])
  }
  // Main "no task" welcome pane first, then split the Tasks rail in on its
  // LEFT (`-b`) at the same fixed cell width a real session uses.
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    SAFE_SPAWN_CWD,
    "-x",
    "220",
    "-y",
    "50",
    "-P",
    "-F",
    "#{pane_id}",
    homeWelcomeCommand(),
  ])
  const mainPane = r0.stdout.trim()
  if (mainPane) {
    // Match the user's global rail width so home looks like the tasks do.
    const tasksWidth = await globalTasksPaneWidth()
    const r1 = await runTmuxCapturing([
      "split-window",
      "-h",
      "-b",
      "-t",
      mainPane,
      "-l",
      `${tasksWidth}`,
      "-c",
      SAFE_SPAWN_CWD,
      "-P",
      "-F",
      "#{pane_id}",
      // Pin kobe's env (KOBE_HOME_DIR / KOBE_DAEMON_SOCKET_PATH / KOBE_TMUX_SOCKET)
      // onto the home rail's command, exactly like buildPanesAround / the heal
      // respawns do. Without it the home rail inherits whatever env the tmux
      // SERVER was born with — which goes stale when the server persists across
      // kobe relaunches (KOBE_* aren't in tmux's update-environment list), so a
      // non-default-home run that lands on home could read/mutate the PRODUCTION
      // tasks.json / a dead daemon — the KOB-244 desync class.
      keepAlive(inheritedEnvPrefix() + tasksPaneCommand(kobeCliInvocation())),
    ])
    const tasksPane = r1.stdout.trim()
    if (tasksPane) {
      await runTmuxSequence([
        ["set-option", "-p", "-t", tasksPane, PANE_ROLE_OPTION, "tasks"],
        ["select-pane", "-t", tasksPane],
      ])
    }
  }
  await setSessionOption(name, HOME_KIND_OPTION, "tasks")
  return name
}

/**
 * If the current tmux client is attached to `killedName`, switch it away
 * before the session is killed so the terminal doesn't go dark.
 *
 * Prefers `nextSessionName` when it exists; falls back to the kobe-home
 * placeholder session (created on demand). No-ops when the current session
 * is not `killedName` (e.g. called from the outer monitor).
 */
export async function switchClientBeforeKill(killedName: string, nextSessionName?: string): Promise<void> {
  const current = await currentSessionName()
  if (current !== killedName) return
  // Fit + heal the target to THIS client BEFORE switching in, exactly like the
  // switch (`switchTo`/`jumpToTask`) paths do — otherwise deleting the active
  // task drops the client onto a session still sized to whatever client last
  // touched it, and it reflows ("window resize") the instant the switch lands.
  // Dynamic import to avoid a static cycle (panes/terminal/tmux re-exports from
  // this module), matching jumpToTask.
  const { prepareWindowForSwitch } = await import("../tui/panes/terminal/tmux.ts")
  if (nextSessionName && nextSessionName !== killedName && (await sessionExists(nextSessionName))) {
    await prepareWindowForSwitch(nextSessionName)
    await runTmux(["switch-client", "-t", `=${nextSessionName}`])
    return
  }
  const fallback = await ensureFallbackSession()
  await prepareWindowForSwitch(fallback)
  await runTmux(["switch-client", "-t", `=${fallback}`])
}
