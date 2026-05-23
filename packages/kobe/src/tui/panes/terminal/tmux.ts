/**
 * tmux-backed interactive sessions (v0.6).
 *
 * Per-task tmux session running inside a dedicated socket (`tmux -L
 * kobe`). Each session is pre-split into three panes — claude on the
 * left, the kobe-ops file watcher on the upper right, and an
 * interactive shell on the lower right. The whole composition is
 * rendered by tmux, so claude can repaint at native speed without
 * kobe's outer renderer fighting it for the TTY.
 *
 * Layout grammar (v0.6 / KOB-228):
 *
 *     ┌──────────────────────┬───────────────┐
 *     │                      │  pane 1: ops  │
 *     │   pane 0: claude     │               │
 *     │   (left, ~60%)       ├───────────────┤
 *     │                      │  pane 2: sh   │
 *     └──────────────────────┴───────────────┘
 *
 * `Ctrl+Q` detaches the client (server-scoped binding on `-L kobe`,
 * so the user's own tmux is untouched). The session keeps running
 * after detach AND across a kobe restart.
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

/** Dedicated tmux socket name — isolates kobe's server from the user's. */
const SOCKET = "kobe"

/** Default left-pane width as a percentage of the window. */
const CLAUDE_PANE_PERCENT = 60

/** Default upper-right (Ops) pane height as a percentage of the right column. */
const OPS_PANE_PERCENT = 50

function tmuxBase(...args: string[]): string[] {
  return ["tmux", "-L", SOCKET, ...args]
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
  return tmuxBase("attach-session", "-t", `=${name}`)
}

async function runTmux(args: string[]): Promise<number> {
  const proc = Bun.spawn(tmuxBase(...args), { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  return await proc.exited
}

async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(tmuxBase(...args), { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
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
 * Count the panes in the session's first window. Used to detect old
 * (v0.5 / KOB-225) one-pane sessions so {@link ensureSession} can
 * rebuild them with the three-pane layout.
 */
async function paneCount(name: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-t", `=${name}:0`, "-F", "#{pane_index}"])
  if (code !== 0) return 0
  const lines = stdout.split("\n").filter((l) => l.length > 0)
  return lines.length
}

export interface EnsureSessionOpts {
  readonly name: string
  /** Working directory for every pane in the new session. */
  readonly cwd: string
  /** argv that pane 0 (the claude pane) runs. */
  readonly command: readonly string[]
  /**
   * argv that pane 1 (the Ops pane) runs. Defaults to the file-tree
   * watcher fallback used until {@link "@sma1lboy/kobe-ops"} (KOB-229)
   * ships.
   */
  readonly opsCommand?: readonly string[]
}

/**
 * Default Ops pane content until KOB-229 lands. A loop that prints
 * the worktree's git status + a short tree once a second so the user
 * sees *something* informative in the upper-right pane out of the box.
 * Falls back to a friendly "lsd not installed" message if neither
 * `lsd` nor `eza` is on PATH.
 */
function defaultOpsCommand(cwd: string): readonly string[] {
  // The shell loop is a single tmux-pane command string: it must
  // survive `split-window -- <cmd>` quoting and stay inside one
  // process group. We pick `lsd` / `eza` at runtime; tmux runs this
  // through `$SHELL -c` so the conditional works.
  const script = `\
cd ${shellQuote(cwd)} && \
while :; do \
  clear; \
  printf "\\033[1m# %s\\033[0m\\n\\n" ${shellQuote(cwd)}; \
  git status --short --branch 2>/dev/null | sed 's/^/  /' || true; \
  printf "\\n"; \
  if command -v lsd >/dev/null 2>&1; then \
    lsd --tree --git -I node_modules -I .git --depth 2 .; \
  elif command -v eza >/dev/null 2>&1; then \
    eza --tree --git -L 2 -I 'node_modules|.git' .; \
  elif command -v tree >/dev/null 2>&1; then \
    tree -L 2 -I 'node_modules|.git'; \
  else \
    ls -la; \
  fi; \
  sleep 2; \
done`
  return ["sh", "-c", script]
}

/**
 * Quote `s` for safe inclusion inside a single-line `sh -c` script.
 * tmux's `split-window` argv passes one string per panel — we build
 * that string ourselves, so any path with a space or quote needs
 * shell-quoting before it reaches the child shell.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Ensure a detached session named `name` exists with the three-pane
 * layout. Idempotent in the happy path: a session that already has
 * the right number of panes is left alone (that's the persistence —
 * a prior session keeps running across detach / kobe restart). A
 * legacy one-pane session is detected by {@link paneCount} and
 * **rebuilt**: killed and recreated. We choose rebuild over in-place
 * `split-window` because a pre-v0.6 session's pane 0 is already
 * running claude with whatever scrollback state the user has, and
 * splitting now would create empty panes 1/2 alongside it — fine for
 * fresh tasks, but the layout would only become "correct" after the
 * user's next kobe restart anyway. Rebuilding gives every existing
 * task the new look on first re-enter.
 */
export async function ensureSession(opts: EnsureSessionOpts): Promise<void> {
  if (await sessionExists(opts.name)) {
    const panes = await paneCount(opts.name)
    if (panes >= 3) return
    // Legacy single-pane session — drop and rebuild.
    await runTmux(["kill-session", "-t", `=${opts.name}`])
  }

  const ops = opts.opsCommand ?? defaultOpsCommand(opts.cwd)

  // Build the session in four steps:
  //   1. `new-session -d` — fresh detached session, pane 0 inherits cwd
  //      but no command (we send-keys claude in step 4 so we keep an
  //      idle pane in front of the user if claude exits / crashes).
  //   2. `split-window -h -p 40` — right column = 40% of the window.
  //   3. `split-window -v -t :.1 -p 50` — split right column 50/50.
  //   4. send `claude` to pane 0 and the Ops command to pane 1.
  // The shell pane (2) stays at its default `$SHELL` prompt.
  await runTmux(["new-session", "-d", "-s", opts.name, "-c", opts.cwd])
  await runTmux(["split-window", "-h", "-t", `=${opts.name}:0.0`, "-p", `${100 - CLAUDE_PANE_PERCENT}`, "-c", opts.cwd])
  await runTmux(["split-window", "-v", "-t", `=${opts.name}:0.1`, "-p", `${100 - OPS_PANE_PERCENT}`, "-c", opts.cwd])

  // Server-scoped niceties — done after the session is alive so the
  // server is definitely up. Both `-g` options are idempotent so
  // calling them on every ensureSession is harmless.
  await runTmux(["set-option", "-g", "status", "off"])
  await runTmux(["bind-key", "-n", "C-q", "detach-client"])

  // Send the actual commands. send-keys + Enter is cleaner than
  // passing the command to `new-session` / `split-window` because:
  //   - the pane stays alive after the command exits (the user is
  //     dropped back to a shell rather than having tmux close the
  //     pane, which would also tear down the window in some configs)
  //   - we can target panes by their stable index regardless of the
  //     order tmux assigned to them
  await runTmux(["send-keys", "-t", `=${opts.name}:0.0`, opts.command.join(" "), "Enter"])
  await runTmux(["send-keys", "-t", `=${opts.name}:0.1`, ops.join(" "), "Enter"])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — that's deliberate, so a user who
  // detached from the Ops pane lands back in it.
  await runTmux(["select-pane", "-t", `=${opts.name}:0.0`])
}

/** Kill a session (if any). Used when a task is removed. */
export async function killSession(name: string): Promise<void> {
  if (await sessionExists(name)) await runTmux(["kill-session", "-t", `=${name}`])
}
