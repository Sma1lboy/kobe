/**
 * Shared low-level tmux client (v0.6 / KOB-233).
 *
 * kobe drives a dedicated tmux server on the `-L kobe` socket
 * (isolated from the user's own tmux). The session-lifecycle code
 * (`tui/panes/terminal/tmux.ts`) and the monitor's read-side capture
 * (`monitor/capture-pane.ts`) + the Ops pane's `send-keys` mention
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

/** Dedicated tmux socket name — isolates kobe's server from the user's. */
export const KOBE_TMUX_SOCKET = "kobe"

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

/**
 * Run a tmux command, logging stderr when it fails. Silent tmux
 * errors are a foot-gun (KOB-233): a `split-window -t :0.0` that
 * failed because of `base-index 1` left the layout broken with no
 * trace. We only emit on a non-zero exit.
 */
export async function runTmux(args: string[]): Promise<number> {
  const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    try {
      const errText = await new Response(proc.stderr).text()
      if (errText.trim().length > 0) console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    } catch {
      // best-effort: the exit code is already surfaced
    }
  }
  return code
}

/** Run a tmux command and capture stdout (stderr logged on failure). */
export async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(tmuxArgs(...args), { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    try {
      const errText = await new Response(proc.stderr).text()
      if (errText.trim().length > 0) console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    } catch {
      /* keep the stdout we did get */
    }
  }
  return { code, stdout: text }
}

/** Is the `tmux` binary on PATH? */
export async function tmuxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "-V"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

/** Does a session with this exact name exist on kobe's socket? */
export async function sessionExists(name: string): Promise<boolean> {
  return (await runTmux(["has-session", "-t", `=${name}`])) === 0
}

/**
 * Every pane id (`%N`) across the session's windows, in tmux's order
 * (which is creation order — so the first id is the claude pane).
 * Pane ids are server-global and immune to `base-index` config.
 */
export async function listPaneIds(sessionName: string): Promise<string[]> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${sessionName}`, "-F", "#{pane_id}"])
  if (code !== 0) return []
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * The id of the session's first pane. `""` when the session doesn't
 * exist. NOTE: tmux numbers panes by POSITION, not creation order, so
 * once the layout grew a left-hand Tasks pane the "first" pane stopped
 * being claude — prefer {@link claudePaneId} for "the claude pane".
 */
export async function firstPaneId(sessionName: string): Promise<string> {
  return (await listPaneIds(sessionName))[0] ?? ""
}

/** Per-pane user option marking the claude pane (set by `ensureSession`). */
export const CLAUDE_ROLE_OPTION = "@kobe_role"
const CLAUDE_ROLE_VALUE = "claude"

/** Tag a pane as the claude pane so {@link claudePaneId} can find it. */
export async function tagClaudePane(paneId: string): Promise<void> {
  await runTmux(["set-option", "-p", "-t", paneId, CLAUDE_ROLE_OPTION, CLAUDE_ROLE_VALUE])
}

/**
 * The id of the session's claude pane, found by its `@kobe_role`
 * user-option tag — robust against tmux's by-position pane numbering
 * (a left-hand Tasks pane renumbers everything). Falls back to the
 * first pane for sessions created before tagging existed. `""` when
 * the session doesn't exist.
 */
export async function claudePaneId(sessionName: string): Promise<string> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${sessionName}`,
    "-F",
    `#{pane_id}\t#{${CLAUDE_ROLE_OPTION}}`,
  ])
  if (code !== 0) return ""
  let firstId = ""
  for (const line of stdout.split("\n")) {
    const [id, role] = line.split("\t")
    if (!id) continue
    if (!firstId) firstId = id.trim()
    if (role?.trim() === CLAUDE_ROLE_VALUE) return id.trim()
  }
  return firstId
}

/**
 * Capture the visible text of `paneId`. `lines` (optional) extends the
 * capture `lines` rows up into scrollback. Returns `""` on any error.
 * ANSI escapes are kept (`-e`) so a caller that wants colour has it;
 * callers that render plain text strip via `stripAnsi`.
 */
export async function capturePaneById(paneId: string, lines?: number): Promise<string> {
  if (!paneId) return ""
  const args = ["capture-pane", "-t", paneId, "-p"]
  if (typeof lines === "number" && lines > 0) args.push("-S", String(-lines))
  const { code, stdout } = await runTmuxCapturing(args)
  return code === 0 ? stdout : ""
}

/** Send literal keys to a pane (used for `@file` mention injection). */
export async function sendKeys(target: string, text: string): Promise<void> {
  await runTmux(["send-keys", "-t", target, text])
}

/**
 * Open a new window in `session` running `command` (via tmux's own
 * `sh -c`). Used for the full-width file/diff preview. `name` sets the
 * window's status-bar label. When `command` exits (e.g. the pager
 * quits), tmux closes the window and switches back to the previous one.
 */
export async function newWindow(session: string, opts: { cwd: string; command: string; name?: string }): Promise<void> {
  const args = ["new-window", "-t", `=${session}`, "-c", opts.cwd]
  if (opts.name) args.push("-n", opts.name)
  args.push(opts.command)
  await runTmux(args)
}

/** Kill a session (if any). */
export async function killSession(name: string): Promise<void> {
  if (await sessionExists(name)) await runTmux(["kill-session", "-t", `=${name}`])
}
