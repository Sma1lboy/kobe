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
 * tab (window). Everything is rendered by tmux, so claude repaints at
 * native speed without kobe's outer renderer fighting for the TTY.
 *
 * `Ctrl+Q` detaches back to the outer monitor; `Ctrl+h/j/k/l` move
 * between panes. All bindings are server-scoped on `-L kobe`, so the
 * user's own tmux is untouched. Sessions persist across detach AND a
 * kobe restart.
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { interactiveEngineCommand } from "@/engine/interactive-command"
import {
  getSessionOption,
  listPaneIds,
  paneIdByRole,
  runTmux,
  runTmuxCapturing,
  sendKeys,
  sessionExists,
  setSessionOption,
  tagClaudePane,
  tagPaneRole,
} from "@/tmux/client"
import {
  CLAUDE_PANE_PERCENT,
  OPS_PANE_PERCENT,
  TASKS_PANE_PERCENT,
  keepAlive,
  opsPaneCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"

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
  /**
   * Engine vendor — tagged on the session (`@kobe_vendor`) so a new
   * chat tab ({@link newChatTab}) relaunches the SAME engine, not a
   * hard-coded `claude`.
   */
  readonly vendor?: string
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
    const taggedWorktree = await getSessionOption(opts.name, "@kobe_worktree")
    const taggedVendor = await getSessionOption(opts.name, "@kobe_vendor")
    // Reuse ONLY a healthy session that matches this task. Failure modes
    // this guards against (KOB-233):
    //   - Wrong layout: fewer than the full 4 panes (tasks / claude /
    //     ops / shell) → legacy/broken, rebuild.
    //   - Wrong PLACE: same name (`kobe-<taskId>`) but a different /
    //     empty `@kobe_worktree` — a stale session from before the
    //     env+socket isolation, whose panes run in the wrong dir / wrong
    //     KOBE_HOME. Reusing it drops the user into the wrong env.
    //   - Wrong ENGINE: the task's vendor changed (`setVendor`) since
    //     the session was built, so `@kobe_vendor` no longer matches —
    //     the running pane is the OLD engine. Rebuild so the new pane
    //     launches the engine the task now wants.
    const vendorOk = !opts.vendor || taggedVendor === opts.vendor
    if (panes >= 4 && taggedWorktree === opts.cwd && vendorOk) return
    await runTmux(["kill-session", "-t", `=${opts.name}`])
  }

  // Create the session's first window with the claude pane, then build
  // the surrounding panes. Each pane command is passed as the trailing
  // arg to new-session / split-window — tmux runs it via its own
  // `sh -c`, so we hand it a single shell command STRING and skip
  // send-keys (which re-parses text and mangled the Ops `sh -c` quoting
  // in KOB-233). Pane ids (`%N`) are server-global and immune to
  // `base-index`, so we always target by id.
  const inv = kobeCliInvocation()
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
    keepAlive(shellQuoteArgv(opts.command)),
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return
  }

  // Tag the session with the task id + worktree so `kobe new-chattab`
  // (the Ctrl+T handler) can rebuild the same workspace in a new window.
  if (opts.taskId) await setSessionOption(opts.name, "@kobe_task", opts.taskId)
  await setSessionOption(opts.name, "@kobe_worktree", opts.cwd)
  if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)

  await buildPanesAround(pane0, { cwd: opts.cwd, taskId: opts.taskId, opsCommand: opts.opsCommand, inv })

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
  // Mouse: ON. The Tasks pane's click-to-switch and the Ops FileTree's
  // click/scroll only work if tmux forwards mouse events to the pane's
  // app. Most configs already set this, but we force it on the `-L
  // kobe` socket so the feature doesn't depend on the user's config.
  await runTmux(["set-option", "-g", "mouse", "on"])
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
  // Ctrl+T opens a new chat tab = a new window with its own claude
  // (fresh conversation) + the same panes, on the same worktree. The
  // window status bar becomes the chat-tab switcher (Ctrl+B n/p too).
  // `kobe new-chattab` reads the session's @kobe_task / @kobe_worktree
  // tags so the binding only needs to pass the session name (which
  // tmux expands at fire time).
  const invStr = inv.map(shellQuote).join(" ")
  await runTmux(["bind-key", "-n", "C-t", "run-shell", `${invStr} new-chattab --session '#{session_name}'`])
  // `<prefix> f` = quick-create: focus the Tasks pane and open the
  // new-task dialog there (the v0.5 quick-fork chord, KOB-74, reborn in
  // the tmux world). `kobe quick-create` selects the tasks pane and
  // injects `n`, so the dialog + its logic are exactly the Tasks pane's
  // createTask — no separate code path. PREFIX-scoped (not no-prefix
  // C-f): a no-prefix Ctrl+F was unusable — it shadows readline
  // forward-char in the claude/shell panes and several apps grab it, so
  // the chord never reliably reached tmux. `<prefix> f` ("fork") is a
  // two-key chord but conflict-free; the prefix is whatever the user's
  // own tmux.conf sets (we load it on the `-L kobe` socket).
  await runTmux(["bind-key", "f", "run-shell", `${invStr} quick-create --session '#{session_name}'`])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])
}

/**
 * Build the workspace panes around a freshly-created claude pane:
 * Tasks (left) + Ops (right-top) + shell (right-bottom). Shared by
 * the session's first window ({@link ensureSession}) and every new
 * chat-tab window ({@link newChatTab}).
 */
async function buildPanesAround(
  claudePane: string,
  args: { cwd: string; taskId?: string; opsCommand?: string; inv: readonly string[] },
): Promise<void> {
  // Tag claude by a pane user-option — tmux renumbers panes by
  // position when the Tasks pane is inserted on the left, so the
  // monitor can't rely on "first pane" to find claude (KOB-233).
  await tagClaudePane(claudePane)

  // Tasks pane to the LEFT (`-hb` inserts before). Task list that
  // switch-clients between task sessions + creates tasks. Tagged
  // `@kobe_role=tasks` so the Ctrl+F quick-create handler can re-find
  // it regardless of tmux's by-position pane numbering.
  const rTasks = await runTmuxCapturing([
    "split-window",
    "-h",
    "-b",
    "-t",
    claudePane,
    "-l",
    `${TASKS_PANE_PERCENT}%`,
    "-c",
    args.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive(tasksPaneCommand(args.inv)),
  ])
  const tasksPane = rTasks.stdout.trim()
  if (tasksPane) await tagPaneRole(tasksPane, "tasks")

  // Ops pane (right column). Uses the claude pane id as its
  // `--target-pane` for `@file` mention injection.
  const opsCmd = keepAlive(
    args.opsCommand ??
      opsPaneCommand({ cwd: args.cwd, taskId: args.taskId, claudePaneId: claudePane, cliInvocation: args.inv }),
  )
  const r1 = await runTmuxCapturing([
    "split-window",
    "-h",
    "-t",
    claudePane,
    "-l",
    `${100 - CLAUDE_PANE_PERCENT}%`,
    "-c",
    args.cwd,
    "-P",
    "-F",
    "#{pane_id}",
    opsCmd,
  ])
  const opsPane = r1.stdout.trim()

  // shell pane (right-bottom) — no command, tmux's default $SHELL.
  if (opsPane) {
    await runTmux(["split-window", "-v", "-t", opsPane, "-l", `${100 - OPS_PANE_PERCENT}%`, "-c", args.cwd])
  }
  await runTmux(["select-pane", "-t", claudePane])
}

/**
 * Open a new chat-tab window in an existing task session: a new
 * tmux window with a fresh engine conversation + the same workspace
 * panes, on the same worktree. Invoked by `kobe new-chattab` (the
 * Ctrl+T handler), which passes only the session name; the worktree +
 * task id + vendor are read back from the session's `@kobe_*` tags so
 * the new tab launches the SAME engine the task was created with.
 */
export async function newChatTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const cwd = (await getSessionOption(session, "@kobe_worktree")) || process.cwd()
  const taskId = (await getSessionOption(session, "@kobe_task")) || undefined
  const vendor = (await getSessionOption(session, "@kobe_vendor")) || undefined
  const command = interactiveEngineCommand(vendor as VendorId | undefined)
  const inv = kobeCliInvocation()
  const r = await runTmuxCapturing([
    "new-window",
    "-t",
    `=${session}`,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive(shellQuoteArgv(command)),
  ])
  const claudePane = r.stdout.trim()
  if (!claudePane) return
  await buildPanesAround(claudePane, { cwd, taskId, inv })
}

/**
 * Quick-create (Ctrl+F): focus the active window's Tasks pane and open
 * its new-task dialog. Implemented by selecting the tasks pane and
 * injecting an `n` keystroke — the Tasks pane's own `n` binding then
 * runs `createTask`, so the dialog and its logic are identical to
 * pressing `n` in the pane directly. Invoked by `kobe quick-create`
 * (the Ctrl+F handler), which passes only the session name.
 */
export async function quickCreate(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const tasksPane = await paneIdByRole(session, "tasks")
  if (!tasksPane) return
  await runTmux(["select-pane", "-t", tasksPane])
  await sendKeys(tasksPane, "n")
}
