/**
 * tmux-backed interactive sessions (v0.6).
 *
 * Per-task tmux session running inside a dedicated socket (`tmux -L
 * kobe`). Each session is pre-split into three panes — claude on the
 * left, the `kobe ops` FileTree pane on the upper right, and an
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

import { kobeCliInvocation } from "@/cli/invocation"
import { listPaneIds, runTmux, runTmuxCapturing, sessionExists } from "@/tmux/client"
import { CLAUDE_PANE_PERCENT, OPS_PANE_PERCENT, keepAlive, opsPaneCommand, shellQuoteArgv } from "@/tmux/session-layout"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`app.tsx`, `LivePreview`, `fullscreen.tsx`) keep their `./tmux` path.
export { attachArgv, killSession, sessionExists, tmuxAvailable, tmuxSessionName } from "@/tmux/client"

/**
 * Count the panes across every window of the session. Used to detect
 * old (v0.5 / KOB-225) one-pane sessions so {@link ensureSession} can
 * rebuild them with the three-pane layout. `listPaneIds` walks the
 * whole session (`-s`), so it sidesteps the user's `base-index` config.
 */
async function paneCount(name: string): Promise<number> {
  return (await listPaneIds(name)).length
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
  // Each pane's command is passed as the trailing arg to
  // new-session / split-window — tmux runs it via its own `sh -c`,
  // so we hand it a single shell command STRING and skip send-keys
  // entirely. send-keys re-parses text through the pane's shell,
  // which mangled the Ops pane's `sh -c "<script>"` quoting (KOB-233).
  //
  // `keepAlive` wraps each command so the pane drops to a shell when
  // the command exits instead of tmux closing it (collapsing the
  // layout). All the command/layout policy is pure + tested in
  // `tmux/session-layout.ts`; this function is just the mechanics.
  const claudeCmd = keepAlive(shellQuoteArgv(opts.command))

  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    opts.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    claudeCmd,
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return
  }

  // Resolve the Ops command now that we know pane 0's id — kobe ops
  // uses it as the `--target-pane` selector for `@file` send-keys
  // injections back into claude.
  const opsCmd = keepAlive(
    opts.opsCommand ??
      opsPaneCommand({
        cwd: opts.cwd,
        taskId: opts.taskId,
        claudePaneId: pane0,
        cliInvocation: kobeCliInvocation(),
      }),
  )

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
    opsCmd,
  ])
  const pane1 = r1.stdout.trim()

  // Pane 2 (bottom right) is a plain shell scoped to the worktree —
  // no command, tmux uses its default-command ($SHELL).
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
  // kobe turned OFF flips back.
  //
  // We deliberately do NOT set status-style / status-left /
  // status-right: the `-L kobe` socket still loads the user's
  // `~/.tmux.conf` (the `-L` flag only changes the socket path, not
  // the config file), so the user's own status-bar theme applies.
  // The session name (`kobe-<task-id>`, shown via the user's
  // default `#S` in status-left) is the only identity we impose.
  await runTmux(["set-option", "-g", "status", "on"])
  // No-prefix Ctrl+Q detaches back to the kobe outer monitor.
  await runTmux(["bind-key", "-n", "C-q", "detach-client"])
  // No-prefix Ctrl+h/j/k/l move between panes directionally — the
  // vim-tmux-navigator convention. (Ctrl+1/2/3 was tried first but
  // terminals can't encode Ctrl+<digit> without the kitty protocol, so
  // the bindings registered yet never fired — KOB-233.) Directional
  // keys DO produce distinct codes and are the tmux-idiomatic choice.
  // Server-scoped on the `-L kobe` socket so the user's own tmux is
  // untouched. Trade-off: this shadows readline Ctrl+k (kill-line) /
  // Ctrl+l (clear) inside the claude + shell panes; acceptable for the
  // pane-nav win, and the prefix (Ctrl+B arrows) still works too.
  await runTmux(["bind-key", "-n", "C-h", "select-pane", "-L"])
  await runTmux(["bind-key", "-n", "C-j", "select-pane", "-D"])
  await runTmux(["bind-key", "-n", "C-k", "select-pane", "-U"])
  await runTmux(["bind-key", "-n", "C-l", "select-pane", "-R"])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])
}
