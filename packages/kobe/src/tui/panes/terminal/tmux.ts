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
 * `Ctrl+Q` detaches back to the launching shell; `Ctrl+h/j/k/l` move
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
  claudePaneIdStrict,
  getSessionOptions,
  paneIdByRole,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  runTmuxSequenceCapturing,
  sendKeys,
  sessionExists,
  setSessionOption,
  windowCount,
} from "@/tmux/client"
import {
  CLAUDE_PANE_PERCENT,
  OPS_PANE_PERCENT,
  TASKS_PANE_WIDTH,
  keepAlive,
  opsPaneCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
} from "@/tmux/session-layout"
import type { VendorId } from "@/types/task"
import { ALL_VENDORS } from "@/types/vendor"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`app.tsx`, `LivePreview`, `fullscreen.tsx`) keep their `./tmux` path.
export { attachArgv, killSession, sessionExists, tmuxAvailable, tmuxSessionName } from "@/tmux/client"

export const CHAT_TAB_SWITCH_BINDINGS = [
  ["bind-key", "-n", "C-[", "previous-window"],
  ["bind-key", "-n", "C-]", "next-window"],
] as const

export const CHAT_TAB_CLOSE_BINDING = [
  "bind-key",
  "-n",
  "C-w",
  "if-shell",
  "-F",
  "#{>:#{session_windows},1}",
  "kill-window",
  "display-message 'Cannot close the only ChatTab'",
] as const

export const CHAT_TAB_RENAME_BINDING = [
  "bind-key",
  "-n",
  "F2",
  "command-prompt",
  "-I",
  "#{window_name}",
  "rename-window -- '%%'",
] as const

export const CHAT_TAB_ENGINE_PROMPT = `engine (${ALL_VENDORS.join("/")})`

export const CHAT_TAB_CHOOSE_ENGINE_BINDINGS = [
  ["bind-key", "-n", "C-S-T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
  ["bind-key", "T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
] as const

export const CHAT_TAB_STATUS_FORMAT = "#{?window_activity_flag,●,○} #I:#W"
export const CHAT_TAB_STATUS_CURRENT_FORMAT = "#{?window_activity_flag,●,○} #I:#W"

export function tmuxInitialSizeArgs(
  stdout: { columns?: number; rows?: number } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const columns = positiveInt(stdout.columns) ?? positiveInt(env.COLUMNS)
  const rows = positiveInt(stdout.rows) ?? positiveInt(env.LINES)
  return columns && rows ? ["-x", `${columns}`, "-y", `${rows}`] : []
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
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

async function ensureSessionImpl(opts: EnsureSessionOpts): Promise<boolean> {
  if (await sessionExists(opts.name)) {
    const sessionOptions = await getSessionOptions(opts.name, ["@kobe_worktree", "@kobe_vendor"])
    const taggedWorktree = sessionOptions["@kobe_worktree"] ?? ""
    const taggedVendor = sessionOptions["@kobe_vendor"] ?? ""
    // Reuse ONLY a healthy session that matches this task. We key health
    // off the LOAD-BEARING claude pane (its `@kobe_role=claude` tag in the
    // active window), NOT a raw pane COUNT. Rationale + failure modes:
    //   - Pane present? `claudePaneIdStrict` returns "" when the active
    //     window has no tagged claude pane: a legacy/pre-tag (v0.5/KOB-225)
    //     one-pane session, or a window whose claude pane was destroyed →
    //     rebuild. Critically, this does NOT fire just because a DISPOSABLE
    //     pane (the shell, or ops) was closed — typing `exit` in the shell
    //     pane used to drop the count below 4 and nuke the whole session,
    //     destroying the live engine conversation (KOB-244). The claude
    //     pane survives that, so we reuse. The check is active-window
    //     scoped, so each Ctrl+T chat-tab window is judged on its own.
    //   - Wrong PLACE: a different/empty `@kobe_worktree` (a stale session
    //     from before env+socket isolation, panes in the wrong dir / wrong
    //     KOBE_HOME) → rebuild so the user isn't dropped into the wrong env.
    //   - Wrong ENGINE: the task's vendor changed (`setVendor`) since the
    //     session was built, so `@kobe_vendor` no longer matches the OLD
    //     engine pane → rebuild so the new pane launches the wanted engine.
    const worktreeOk = taggedWorktree === opts.cwd
    const vendorOk = !opts.vendor || taggedVendor === opts.vendor
    const claudeAlive = (await claudePaneIdStrict(opts.name)) !== ""

    // Happy path: healthy + right place + right engine → reuse as-is.
    if (claudeAlive && worktreeOk && vendorOk) {
      await healTaskPaneWidths(opts.name)
      return true
    }

    // Vendor-only drift (right worktree, the task switched engines via `v`):
    // relaunch the engine pane IN PLACE in EVERY window via respawn-pane
    // instead of kill-session, so the switch takes effect WITHOUT destroying
    // the session's other Ctrl+T chat-tab windows (each its own conversation).
    // respawn-pane keeps each pane's id + @kobe_role tag, so the Ops pane's
    // --target-pane stays valid (KOB-232). Falls through to a full rebuild if
    // no engine pane is found to respawn.
    if (worktreeOk && !vendorOk && opts.command.length > 0) {
      if (await relaunchEngineInAllWindows(opts.name, opts.cwd, opts.command)) {
        if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)
        await healTaskPaneWidths(opts.name)
        return true
      }
    }

    // Right place + right engine but the active window's engine pane is gone,
    // and sibling windows exist: don't `kill-session` (that would drop those
    // sibling chat tabs). Reuse — per-window recreate of a destroyed pane is a
    // future follow-up; the common shell-exit case never gets here because the
    // engine pane survives (KOB-244).
    if (worktreeOk && vendorOk && (await windowCount(opts.name)) > 1) {
      await healTaskPaneWidths(opts.name)
      return true
    }

    // Otherwise rebuild from scratch: a legacy/pre-tag (v0.5/KOB-225) session,
    // a wrong-PLACE session (different @kobe_worktree), or a single-window
    // session whose engine pane was destroyed.
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
    ...tmuxInitialSizeArgs(),
    "-P",
    "-F",
    "#{pane_id}",
    keepAlive(shellQuoteArgv(opts.command)),
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return false
  }

  // Tag the session with the task id + worktree so `kobe new-chattab`
  // (the Ctrl+T handler) can rebuild the same workspace in a new window.
  await runTmuxSequence([
    ...(opts.taskId ? ([["set-option", "-t", opts.name, "@kobe_task", opts.taskId]] as const) : []),
    ["set-option", "-t", opts.name, "@kobe_worktree", opts.cwd],
    ...(opts.vendor ? ([["set-option", "-t", opts.name, "@kobe_vendor", opts.vendor]] as const) : []),
  ])

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
  // We deliberately do NOT set status-style / status-left /
  // status-right: the `-L kobe` socket still loads the user's
  // `~/.tmux.conf` (the `-L` flag only changes the socket path, not
  // the config file), so the user's own status-bar theme applies.
  // The session name (`kobe-<task-id>`, shown via the user's
  // default `#S` in status-left) is the only identity we impose.
  // Window-status format: a compact activity icon in each ChatTab label.
  // `monitor-activity` is tmux-native and means "this window produced
  // output since you last viewed it", which is the reliable signal we have
  // inside a pure tmux handover without scraping engine-specific prompts.
  // Mouse: ON. The Tasks pane's click-to-switch and the Ops FileTree's
  // click/scroll only work if tmux forwards mouse events to the pane's
  // app. Most configs already set this, but we force it on the `-L
  // kobe` socket so the feature doesn't depend on the user's config.
  // No-prefix Ctrl+Q detaches back to the launching shell.
  // No-prefix Ctrl+h/j/k/l move between panes directionally — the
  // vim-tmux-navigator convention. (Ctrl+1/2/3 was tried first but
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
  await runTmuxSequence([
    ["set-option", "-g", "status", "on"],
    ["set-option", "-g", "monitor-activity", "on"],
    ["set-option", "-g", "visual-activity", "off"],
    ["set-option", "-g", "window-status-format", CHAT_TAB_STATUS_FORMAT],
    ["set-option", "-g", "window-status-current-format", CHAT_TAB_STATUS_CURRENT_FORMAT],
    ["set-option", "-g", "mouse", "on"],
    ["bind-key", "-n", "C-q", "detach-client"],
    ["bind-key", "-n", "C-h", "select-pane", "-L"],
    ["bind-key", "-n", "C-j", "select-pane", "-D"],
    ["bind-key", "-n", "C-k", "select-pane", "-U"],
    ["bind-key", "-n", "C-l", "select-pane", "-R"],
    ["bind-key", "-n", "C-t", "run-shell", newChatTabCommand],
    ...CHAT_TAB_CHOOSE_ENGINE_BINDINGS.map((binding) => [...binding, chooseEngineTmuxCommand] as const),
    ...CHAT_TAB_SWITCH_BINDINGS,
    CHAT_TAB_CLOSE_BINDING,
    CHAT_TAB_RENAME_BINDING,
    ["bind-key", "f", "run-shell", `${envStr}${invStr} quick-create --session '#{session_name}'`],
  ])

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])
  return true
}

/**
 * Relaunch the engine (claude/codex) pane in EVERY window of the session
 * in place via `respawn-pane`, preserving the windows and their other
 * panes (and each pane's id + `@kobe_role` tag, so the Ops pane's
 * `--target-pane` keeps pointing at a live pane). Returns `true` if at
 * least one engine pane was respawned, `false` if none was found (caller
 * then falls back to a full rebuild). Used to apply a vendor switch to a
 * multi-window session without `kill-session` dropping sibling chat tabs
 * (KOB-232).
 */
async function relaunchEngineInAllWindows(session: string, cwd: string, command: readonly string[]): Promise<boolean> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    "#{pane_id}\t#{@kobe_role}",
  ])
  if (code !== 0) return false
  const enginePanes = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([, role]) => role?.trim() === "claude")
    .map(([id]) => id?.trim())
    .filter((id): id is string => !!id)
  if (enginePanes.length === 0) return false
  const cmd = keepAlive(shellQuoteArgv(command))
  for (const pane of enginePanes) {
    // `-k` kills the old engine process; `-c` keeps the worktree cwd.
    await runTmux(["respawn-pane", "-k", "-c", cwd, "-t", pane, cmd])
  }
  return true
}

/** Heal existing sessions built before the direct-tmux Tasks pane widened. */
async function healTaskPaneWidths(session: string): Promise<void> {
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    "#{pane_id}\t#{@kobe_role}",
  ])
  if (code !== 0) return
  const taskPanes = stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([, role]) => role?.trim() === "tasks")
    .map(([id]) => id?.trim())
    .filter((id): id is string => !!id)
  await runTmuxSequence(taskPanes.map((pane) => ["resize-pane", "-t", pane, "-x", `${TASKS_PANE_WIDTH}`]))
}

/**
 * Shell `KEY='val' …` prefix that pins kobe's env onto an inner pane's
 * command so the pane uses the SAME home dir / daemon / tmux server as
 * the outer monitor that created it — independent of tmux-server env
 * inheritance, which goes stale when a server persists across outer
 * restarts. Without this the Tasks pane could read the PRODUCTION
 * `~/.kobe/tasks.json` (KOBE_HOME_DIR missing) or connect to a dead
 * daemon (KOBE_DAEMON_SOCKET_PATH stale) → its task list / clicks
 * desynced from the outer monitor (KOB-244).
 */
function inheritedEnvPrefix(): string {
  const parts: string[] = []
  for (const key of ["KOBE_HOME_DIR", "KOBE_DAEMON_SOCKET_PATH", "KOBE_TMUX_SOCKET"]) {
    const value = process.env[key]
    if (value && value.length > 0) parts.push(`${key}=${shellQuote(value)}`)
  }
  return parts.length > 0 ? `${parts.join(" ")} ` : ""
}

/**
 * Build the workspace panes around a freshly-created claude pane:
 * Tasks (left) + Ops (right-top) + shell (right-bottom). Shared by
 * the session's first window ({@link ensureSession}) and every new
 * chat-tab window ({@link newChatTab}).
 */
async function buildPanesAround(
  claudePane: string,
  args: { cwd: string; taskId?: string; opsCommand?: string; inv: readonly string[]; vendor?: string },
): Promise<void> {
  // Tag claude by a pane user-option — tmux renumbers panes by
  // position when the Tasks pane is inserted on the left, so the
  // monitor can't rely on "first pane" to find claude (KOB-233).
  const envPrefix = inheritedEnvPrefix()

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
    [
      "split-window",
      "-h",
      "-b",
      "-t",
      claudePane,
      "-l",
      // Fixed cell width (no `%`) so the Tasks rail is the same size in every
      // window + across engine rebuilds (KOB-248).
      `${TASKS_PANE_WIDTH}`,
      "-c",
      args.cwd,
      "-P",
      "-F",
      "tasks=#{pane_id}",
      keepAlive(envPrefix + tasksPaneCommand(args.inv)),
    ],
    [
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
      "ops=#{pane_id}",
      opsCmd,
    ],
    ["split-window", "-v", "-l", `${100 - OPS_PANE_PERCENT}%`, "-c", args.cwd],
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
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, "@kobe_role", "ops"]] as const) : []),
  ])
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
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const vendor = vendorOverride ?? (sessionOptions["@kobe_vendor"] as VendorId | undefined)
  if (vendorOverride) await rememberSessionVendor(session, taskId, vendorOverride)
  const command = interactiveEngineCommand(vendor)
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
  await buildPanesAround(claudePane, { cwd, taskId, inv, vendor })
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
    const { connectOrStartDaemon } = await import("@/client/daemon-process")
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
