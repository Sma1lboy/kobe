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

/**
 * Run a tmux command, capturing stderr to the log when it fails. Silent
 * tmux errors are a foot-gun: KOB-233 had `split-window -t :0.0` silently
 * fail because the user's tmux uses `base-index 1`, so the rebuild path
 * ended up creating empty sessions and nobody noticed for hours. Logging
 * is cheap; we only emit when the exit code is non-zero.
 */
async function runTmux(args: string[]): Promise<number> {
  const proc = Bun.spawn(tmuxBase(...args), { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    try {
      const errText = await new Response(proc.stderr).text()
      if (errText.trim().length > 0) console.error(`[kobe tmux] ${args.join(" ")} (${code}): ${errText.trim()}`)
    } catch {
      // best-effort: we surfaced the exit code already
    }
  }
  return code
}

async function runTmuxCapturing(args: string[]): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(tmuxBase(...args), { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
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
 * Count the panes across every window of the session. Used to detect
 * old (v0.5 / KOB-225) one-pane sessions so {@link ensureSession} can
 * rebuild them with the three-pane layout.
 *
 * `list-panes -s` walks the whole session, which sidesteps the user's
 * `base-index` setting — targeting `:0` outright (as the first
 * implementation did) returned an empty list whenever the user's tmux
 * was configured with `base-index 1`, and the rebuild path "succeeded"
 * by silently creating an empty session.
 */
async function paneCount(name: string): Promise<number> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${name}`, "-F", "#{pane_id}"])
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
   * argv that pane 1 (the Ops pane) runs. Defaults to
   * `kobe-ops --task-id <taskId> --worktree <cwd>` (shipped as
   * `@sma1lboy/kobe-ops` since v0.6.0); if the bin isn't on PATH we
   * fall back to the inline git-status + tree watcher.
   */
  readonly opsCommand?: readonly string[]
  /**
   * Stable kobe task id — used to build the default `kobe-ops` argv
   * and the `target-pane` selector. Optional so callers that supply
   * their own `opsCommand` don't need to pass it.
   */
  readonly taskId?: string
}

/**
 * Resolve the default Ops pane argv. Prefers the shipped
 * `@sma1lboy/kobe-ops` binary (KOB-229), falling back to an inline
 * shell loop that prints `git status` + a tree if it's unavailable.
 * The fallback is also used in dev when `kobe-ops` hasn't been linked
 * into PATH yet.
 *
 * `claudePaneId` is the tmux pane id (`%N`) of the claude pane — pane
 * ids are server-global and survive `base-index` differences, so
 * kobe-ops sends keystrokes back to claude by id rather than by index.
 */
function defaultOpsCommand(cwd: string, taskId: string | undefined, claudePaneId: string | null): readonly string[] {
  if (taskId && claudePaneId) {
    // `kobe-ops` is linked into node_modules/.bin as a workspace
    // dependency of kobe; Bun automatically adds that directory to
    // PATH for spawned subprocesses, so a bare `kobe-ops` invocation
    // works in dev. Production installs see the same path via npm's
    // bin shim. If the binary is missing the tmux pane exits
    // immediately and the user sees an empty pane — `fallbackOpsScript`
    // covers that case via `sh -c || ...` so the pane stays useful.
    return [
      "sh",
      "-c",
      `kobe-ops --task-id ${shellQuote(taskId)} --worktree ${shellQuote(cwd)} --target-pane ${shellQuote(claudePaneId)} ` +
        `|| ${fallbackOpsScript(cwd)}`,
    ]
  }
  return ["sh", "-c", fallbackOpsScript(cwd)]
}

/**
 * Plain shell-command string that prints `git status` + a tree on a
 * loop. Used either directly (when no taskId is provided) or as the
 * `||` fallback after `kobe-ops` fails to launch.
 */
function fallbackOpsScript(cwd: string): string {
  return `\
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
    // Legacy / broken layout — drop and rebuild from scratch.
    await runTmux(["kill-session", "-t", `=${opts.name}`])
  }

  // Build the session in three splits, capturing each pane's tmux
  // pane id (`%N`) so we can target by id afterwards. Pane ids are
  // server-global and immune to the user's `base-index` /
  // `pane-base-index` config — targeting by `=name:0.0` (which we did
  // first) broke on any tmux server using `base-index 1`, the default
  // in most popular tmux configs. Bug history: KOB-233.
  //
  // Layout grammar:
  //   step 1: new-session -d                 → pane 0 (left, full size)
  //   step 2: split-window -h (40% right)    → pane 1 (right column)
  //   step 3: split-window -v on pane 1 (50%) → pane 2 (right bottom)
  // -l N% is the modern replacement for the deprecated -p N flag.
  const r0 = await runTmuxCapturing(["new-session", "-d", "-s", opts.name, "-c", opts.cwd, "-P", "-F", "#{pane_id}"])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return
  }

  // Resolve the Ops pane argv now that we know pane 0's id — kobe-ops
  // uses it as the `--target-pane` selector for future `send-keys`
  // injections back into claude.
  const ops = opts.opsCommand ?? defaultOpsCommand(opts.cwd, opts.taskId, pane0)

  const r1 = await runTmuxCapturing([
    "split-window",
    "-h",
    "-t",
    pane0,
    "-l",
    `${100 - CLAUDE_PANE_PERCENT}%`,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{pane_id}",
  ])
  const pane1 = r1.stdout.trim()

  // We only need pane 1's id for the vertical split + the Ops
  // send-keys; pane 2's id isn't used after creation (it inherits
  // the user's $SHELL via tmux's default-command).
  if (pane1) {
    await runTmuxCapturing([
      "split-window",
      "-v",
      "-t",
      pane1,
      "-l",
      `${100 - OPS_PANE_PERCENT}%`,
      "-c",
      opts.cwd,
      "-P",
      "-F",
      "#{pane_id}",
    ])
  }

  // Server-scoped niceties — done after the session is alive so the
  // server is definitely up. All `-g` options are idempotent so
  // calling them on every ensureSession is harmless.
  //
  // Status bar: ON (KOB-233). v0.5/KOB-225 hid it because there was
  // only one pane and it was pure noise. With three panes it's useful
  // — it tells the user they're inside a kobe-managed tmux session,
  // which pane/window is active, and how to get out. We explicitly
  // set `on` (not just "leave default") so a server that an older
  // kobe turned OFF flips back. Styled in kobe's claude-orange accent
  // so it reads as intentional, not stock-tmux green.
  await runTmux(["set-option", "-g", "status", "on"])
  await runTmux(["set-option", "-g", "status-style", "bg=#cc785c,fg=#1a1a1a"])
  await runTmux(["set-option", "-g", "status-left-length", "60"])
  await runTmux(["set-option", "-g", "status-left", " #[bold]kobe#[default] ▸ #S "])
  await runTmux(["set-option", "-g", "status-right-length", "60"])
  await runTmux(["set-option", "-g", "status-right", " #[bold]ctrl+q#[default] detach → kobe "])
  // No-prefix Ctrl+Q detaches back to the kobe outer monitor.
  await runTmux(["bind-key", "-n", "C-q", "detach-client"])

  // Send commands by pane id. send-keys + Enter is cleaner than
  // passing the command to new-session / split-window because the
  // pane stays alive after the command exits (the user lands in a
  // shell prompt rather than tmux closing the pane).
  await runTmux(["send-keys", "-t", pane0, opts.command.join(" "), "Enter"])
  if (pane1) await runTmux(["send-keys", "-t", pane1, ops.join(" "), "Enter"])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])
}

/** Kill a session (if any). Used when a task is removed. */
export async function killSession(name: string): Promise<void> {
  if (await sessionExists(name)) await runTmux(["kill-session", "-t", `=${name}`])
}
