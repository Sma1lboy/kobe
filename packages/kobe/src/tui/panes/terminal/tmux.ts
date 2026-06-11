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
 * `Ctrl+Q` is two-stage: it first focuses the current window's Tasks
 * pane, and only detaches back to the launching shell on a second press
 * from the Tasks pane. `Ctrl+h/j/k/l` move
 * between panes. All bindings are server-scoped on `-L kobe`, so the
 * user's own tmux is untouched. Sessions persist across detach AND a
 * kobe restart.
 *
 * This file is the session APPLIER: `ensureSession`'s observe → decide →
 * apply pipeline plus the engine-launch weaving (init script, remote
 * wrap, session option tagging, server-scoped bindings). Its sibling
 * modules hold the rest of the machinery and are re-exported below so
 * callers keep one import path:
 *
 *   - `session-decision.ts` (`src/tmux/`) — the pure reuse/respawn/
 *     rebuild DECISION; `session-layout.ts` — the pure pane commands +
 *     sizes; `keybindings.ts` — the user-resolvable tmux key set.
 *   - `./chattab.ts` — ChatTab lifecycle: window formats/bindings,
 *     `buildPanesAround`, `newChatTab`, and the dedicated single-page
 *     windows (settings / new-task / update / quick-task).
 *   - `./pane-heal.ts` — version-tagged in-place respawns of the
 *     kobe-owned Tasks/Ops panes + the vendor-switch engine respawn.
 *   - `./launch.ts` — shared launch-line helpers (env pinning, remote
 *     engine wrap).
 *
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId } from "@/engine/interactive-command"
import { worktreeInitMarkerPath } from "@/env"
import { localSpawnCwd, remoteKeyForRepo } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  paneIdByRole,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
  setSessionOption,
  setWindowOption,
} from "@/tmux/client"
import {
  TMUX_FOCUS_DEFAULTS,
  TMUX_FOCUS_ID,
  TMUX_SINGLE_BINDING_DEFAULTS,
  chordToTmuxKey,
  resolveUserTmuxKeys,
} from "@/tmux/keybindings"
import { deliverFirstPrompt } from "@/tmux/prompt-delivery"
import { type ObservedSession, decideSessionAction } from "@/tmux/session-decision"
import { engineLaunchLine, shellQuote, shellQuoteArgv } from "@/tmux/session-layout"
import { applyTmuxPaneBorderTheme } from "@/tui/lib/tmux-border-theme"
import {
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  buildPanesAround,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
} from "./chattab"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { healWorkspaceLayout, relaunchEngineInAllWindows } from "./pane-heal"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`direct.ts`, pane hosts) keep their `./tmux` path.
export {
  attachArgv,
  currentSessionName,
  killSession,
  sessionExists,
  switchClientBeforeKill,
  tmuxAvailable,
  tmuxSessionName,
} from "@/tmux/client"

// Re-export the ChatTab lifecycle + heal surfaces extracted into sibling
// modules, so every pre-split importer (hosts, CLI handlers, tests) keeps
// resolving them from `panes/terminal/tmux`.
export {
  CHAT_TAB_ENGINE_PROMPT,
  CHAT_TAB_STATE_OPTION,
  CHAT_TAB_STATUS_CURRENT_FORMAT,
  CHAT_TAB_STATUS_FORMAT,
  chatTabChooseEngineBindings,
  chatTabCloseBinding,
  chatTabRenameBinding,
  chatTabSwitchBindings,
  kobeStatusRight,
  newChatTab,
  openHelpTab,
  openNewTaskTab,
  openSettingsTab,
  openUpdateTab,
  quickCreate,
} from "./chattab"
export {
  PANE_VERSION_OPTION,
  captureGlobalLayout,
  healSessionLayout,
  refreshKobeWorkspacePanes,
} from "./pane-heal"

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

/**
 * Fit a session's active window to THIS terminal and heal the layout BEFORE
 * attaching, so the very first painted frame is already correct.
 *
 * Without this the attach itself is the resize: the session's window is at a
 * stale size (built detached, or persisted from a different terminal), tmux
 * reflows every pane PROPORTIONALLY when the client lands — the rail blows up —
 * and the `window-resized` hook only snaps it back ~300ms later. That snap is
 * the visible "flash". Resizing the window to the client's size up front (while
 * nothing is on screen yet, pre-attach) means the attach causes NO reflow, and
 * healing at that final size leaves the layout right from frame one. The
 * `window-resized` hook still covers later live terminal resizes. No-op size
 * when the terminal dimensions are unknown (degrades to today's behaviour).
 */
export async function prepareWindowForAttach(session: string): Promise<void> {
  const sizeArgs = tmuxInitialSizeArgs()
  if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${session}`, ...sizeArgs])
  await healWorkspaceLayout(session)
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
   * chat tab (`newChatTab`) relaunches the SAME engine, not a
   * hard-coded `claude`.
   */
  readonly vendor?: string
  /**
   * The task's repo/project key — a local repo root path, or a remote
   * project's `ssh://user@host[:port]` key. Callers pass `task.repo` AS-IS;
   * remoteness is derived in here (via `remoteKeyForRepo`), never at the
   * call site. A remote task launches its engine over SSH on the remote
   * host and spawns every pane in a local dir (the worktree is remote);
   * absent/local keeps today's behavior verbatim.
   */
  readonly repo?: string
  /**
   * Per-repo init script woven before the engine on a FRESH session (runs
   * in the same shell so `export`s reach the engine; once-per-worktree via
   * a marker under `<home>/.kobe/`). No-op on reuse — only the create path
   * applies it. Resolve via {@link resolveRepoInit}.
   */
  readonly initScript?: string
  /**
   * Per-repo first prompt — pasted as the engine's first message right
   * after a FRESH session's engine is ready. Fire-and-forget; never sent
   * on reuse/re-attach. Resolve via {@link resolveRepoInit}.
   */
  readonly initPrompt?: string
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

/**
 * `list-panes -s -F` format answering EVERY observe question in one tmux
 * spawn: `#{@kobe_worktree}` / `#{@kobe_vendor}` are session-scoped user
 * options, which tmux format expansion resolves from any pane of the
 * session (format lookup consults pane, window, session and global option
 * scopes — verified on tmux 3.5a); `window_active` scopes the
 * claude-pane-alive check to the session's current window, matching the
 * old `claudePaneIdStrict` (`list-panes` without `-s` lists the current
 * window's panes); distinct `window_id`s are the window count.
 */
const OBSERVE_SESSION_FORMAT = "#{window_id}\t#{window_active}\t#{@kobe_role}\t#{@kobe_worktree}\t#{@kobe_vendor}"

/** Parse `list-panes -F OBSERVE_SESSION_FORMAT` output. Pure, exported for tests. */
export function parseObservedSession(stdout: string): ObservedSession {
  let worktree = ""
  let vendor = ""
  let claudePaneAlive = false
  const windows = new Set<string>()
  for (const line of stdout.split("\n")) {
    const [windowId, active, role, wt, vd] = line.split("\t")
    if (!windowId?.trim()) continue
    windows.add(windowId.trim())
    if (!worktree && wt?.trim()) worktree = wt.trim()
    if (!vendor && vd?.trim()) vendor = vd.trim()
    if (active?.trim() === "1" && role?.trim() === "claude") claudePaneAlive = true
  }
  return { worktree, vendor, claudePaneAlive, windowCount: windows.size }
}

/**
 * Snapshot the facts about an existing session that the reuse/respawn/
 * rebuild decision needs (`null` when no session exists). All read-only
 * tmux queries live here; the policy that consumes them is the pure
 * `decideSessionAction` in `tmux/session-decision.ts`. Two tmux spawns:
 * the quiet existence probe, then ONE `list-panes -s` whose format
 * ({@link OBSERVE_SESSION_FORMAT}) carries the session options, the
 * active-window claude-pane check and the window count that previously
 * took three more spawns (`show-options` ×2 batched, `list-panes`,
 * `list-windows`). A listing that fails AFTER the existence probe (the
 * session vanished mid-observe) degrades to the same all-empty snapshot
 * the three independent failed queries used to produce — the decision
 * then rebuilds, exactly as before.
 */
async function observeSession(name: string): Promise<ObservedSession | null> {
  if (!(await sessionExists(name))) return null
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-s", "-t", `=${name}`, "-F", OBSERVE_SESSION_FORMAT])
  if (code !== 0) return { worktree: "", vendor: "", claudePaneAlive: false, windowCount: 0 }
  return parseObservedSession(stdout)
}

async function ensureSessionImpl(opts: EnsureSessionOpts): Promise<boolean> {
  // (Engine activity hooks are NOT installed here — they live in the user's
  // global ~/.claude/settings.json, installed once on launch by
  // `ensureGlobalKobeHooks`, and report their cwd so the daemon maps each event
  // to a task. No per-worktree write, so reuse/rebuild/fresh all behave the
  // same and a project's real repo root is never touched.)
  //
  // Observe → decide → apply. The WHY of each branch (KOB-244 pane-count
  // trap, KOB-232 sibling-tab preservation, legacy/pre-tag rebuilds) is
  // documented on `decideSessionAction`; this function only applies the
  // chosen action against the real tmux server.
  const observed = await observeSession(opts.name)
  const action = decideSessionAction(observed, {
    cwd: opts.cwd,
    vendor: opts.vendor,
    hasEngineCommand: opts.command.length > 0,
  })
  // The ONE remoteness derivation for this session build: a remote project's
  // key (`ssh://…`) or undefined for a local task. Everything below asks the
  // resolved host, never re-derives.
  const remoteKey = remoteKeyForRepo(opts.repo)

  // Reuse (healthy, or degraded multi-window — see the decision's reason):
  // leave the session running, just heal pane widths + stale kobe-owned
  // pane versions.
  if (action.kind === "reuse") {
    await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
    return true
  }

  // Vendor switch: relaunch the engine pane IN PLACE in every window via
  // respawn-pane (keeps pane ids + @kobe_role tags, so the Ops pane's
  // --target-pane stays valid — KOB-232). Falls through to a full rebuild
  // when no engine pane is found to respawn — that fact is only knowable
  // here at apply time, so it's the applier's fallback, not the decision's.
  if (action.kind === "respawn-engine") {
    if (await relaunchEngineInAllWindows(opts.name, opts.cwd, opts.command, remoteKey)) {
      if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)
      await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
      return true
    }
  }

  // Rebuild (or a respawn that found no engine pane): kill, then fall
  // through to the shared create path below.
  if (action.kind === "rebuild" || action.kind === "respawn-engine") {
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
  // Force a known session id for a claude launch so this window can be mapped
  // to its transcript and auto-named from its first prompt (KOB). No-op for
  // codex/copilot or a command that already pins its session.
  const launch = withClaudeSessionId(opts.command, opts.vendor)
  // Remote task: the engine runs over SSH on the remote host (`ssh … 'cd <wt>
  // && <engine>'`), and the pane spawns in a LOCAL dir since the worktree is
  // remote. The repo's init script is deferred for remote (it runs locally
  // today — see docs/design/remote-projects.md phase 8), so it's skipped here.
  const engineCmd = wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, opts.cwd)
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    opts.name,
    "-c",
    localSpawnCwd(opts.cwd),
    ...tmuxInitialSizeArgs(),
    "-P",
    "-F",
    "#{pane_id}",
    // Weave the per-repo init script before the engine (once-per-worktree
    // via a marker under <home>/.kobe/). Plain keepAlive when there's none.
    engineLaunchLine(engineCmd, {
      initScript: remoteKey ? undefined : opts.initScript,
      markerPath: !remoteKey && opts.initScript ? worktreeInitMarkerPath(opts.cwd) : undefined,
    }),
  ])
  const pane0 = r0.stdout.trim()
  if (!pane0) {
    console.error("[kobe tmux] new-session returned no pane id; session creation failed")
    return false
  }
  if (launch.sessionId) await setWindowOption(pane0, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)

  // Tag the session with the task id + worktree so `kobe new-chattab`
  // (the Ctrl+T handler) can rebuild the same workspace in a new window.
  await runTmuxSequence([
    ...(opts.taskId ? ([["set-option", "-t", opts.name, "@kobe_task", opts.taskId]] as const) : []),
    ["set-option", "-t", opts.name, "@kobe_worktree", opts.cwd],
    ...(opts.vendor ? ([["set-option", "-t", opts.name, "@kobe_vendor", opts.vendor]] as const) : []),
    ...(remoteKey ? ([["set-option", "-t", opts.name, REMOTE_KEY_OPTION, remoteKey]] as const) : []),
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
  // We deliberately do NOT set status-style / status-left: the `-L
  // kobe` socket still loads the user's `~/.tmux.conf` (the `-L` flag
  // only changes the socket path, not the config file), so the user's
  // own status-bar theme applies. The session name (`kobe-<task-id>`,
  // shown via the user's default `#S` in status-left) is the only
  // identity we impose on the left.
  //
  // status-right IS set — but minimally: from inside the engine/shell
  // pane the user otherwise has zero on-screen hint for kobe's
  // escape-hatch chords (get back to Tasks, detach, new tab). We show
  // the three most useful ones, dimmed (`fg=brightblack`) so they read
  // as a muted hint and don't fight the user's theme. Server-scoped on
  // the isolated `-L kobe` socket, so the user's real tmux status-right
  // is never touched.
  // Window-status format: a compact activity icon in each ChatTab label.
  // `monitor-activity` is tmux-native and means "this window produced
  // output since you last viewed it", which is the reliable signal we have
  // inside a pure tmux handover without scraping engine-specific prompts.
  // Mouse: ON. The Tasks pane's click-to-switch and the Ops FileTree's
  // click/scroll only work if tmux forwards mouse events to the pane's
  // app. Most configs already set this, but we force it on the `-L
  // kobe` socket so the feature doesn't depend on the user's config.
  // No-prefix Ctrl+Q is two-stage: focus the current window's Tasks pane,
  // then detach back to the launching shell on a second press from there.
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
  // Two-stage Ctrl+Q: `kobe focus-tasks` selects the current window's Tasks
  // pane (the else branch of the if-shell below). The "are we already on the
  // Tasks pane?" test is the native `@kobe_role` pane tag, so only the
  // detach branch is reached once focus is on Tasks.
  const focusTasksCommand = `${envStr}${invStr} focus-tasks --session '#{session_name}'`
  const focusTasksTmuxCommand = `run-shell ${shellQuote(focusTasksCommand)}`
  // Re-pin the layout whenever a window settles to a new size. The FIRST task
  // session is built before any client is attached, so tmux sizes its window to
  // a stale default and reflows every pane PROPORTIONALLY once `attach` lands
  // the real terminal size — blowing up the absolute-width Tasks rail. The reuse
  // path heals later switches, but the first attach had none, so the very first
  // view was off until the user switched once.
  //
  // The hook is `window-resized`, NOT `client-attached`: on attach with a size
  // change tmux fires `client-attached` BEFORE it resizes the window (so a heal
  // there runs against the OLD size and is immediately undone by the resize),
  // then `window-resized` AFTER the new size lands. Healing on `window-resized`
  // re-pins against the SETTLED size — and also covers a live terminal resize,
  // which reflows the rail the same way. `-b` runs it in the background so tmux
  // isn't blocked; `resize-pane` never changes the window size, so the heal
  // can't re-trigger the hook. `heal-layout` is a no-op for role-less sessions.
  const healLayoutCommand = `${envStr}${invStr} heal-layout --session '#{session_name}'`
  const healLayoutTmuxCommand = `run-shell -b ${shellQuote(healLayoutCommand)}`
  // `<prefix> f` = quick-create: open the prompt-only quick-task page (the
  // v0.5 quick-fork chord, KOB-74, reborn in the tmux world). `kobe
  // quick-create` opens `kobe quick-task` in its own window, which asks for
  // ONLY a prompt and fills repo / engine / base branch from this task's
  // defaults, then creates + delivers and exits. PREFIX-scoped (not no-prefix
  // C-f): a no-prefix Ctrl+F was unusable — it shadows readline
  // forward-char in the claude/shell panes and several apps grab it, so
  // the chord never reliably reached tmux. `<prefix> f` ("fork") is a
  // two-key chord but conflict-free; the prefix is whatever the user's
  // own tmux.conf sets (we load it on the `-L kobe` socket).
  // Multi-client sizing: a task session can have >1 client attached (two
  // `kobe` processes on the same task, or a detached big terminal + a fresh
  // small one). tmux's default sizes a window to the SMALLEST client of the
  // session regardless of which window that client is actually viewing — so a
  // small client on chat-tab B drags chat-tab A down for the big client too,
  // which then squeezes the fixed-width Tasks pane (KOB-248) against a too-narrow
  // window. `aggressive-resize on` scopes the size to the client(s) for which the
  // window is CURRENT, so each chat-tab window tracks only its own viewer. The
  // hard tmux limit remains: two clients on the SAME window share one grid, so
  // the larger one is letterboxed — that case can't be fixed without per-client
  // sessions (a larger refactor, deferred).
  // Session keys come from the user-resolvable tmux key set (defaults
  // C-q / C-hjkl / C-t / C-S-T / C-[ / C-] / C-w / F2; overridable via
  // `~/.kobe/settings/keybindings.yaml`, `tmux.*` ids). For every
  // OVERRIDDEN id we first unbind its DEFAULT key: the tmux server is
  // long-lived, so a previous run (or an older kobe) may have bound it —
  // without the unbind both the old and new chord would fire. Unbinding
  // a never-bound root key exits 0 silently, so this is safe on a fresh
  // server too. An id resolved to null installs nothing (user unbind).
  const userKeys = resolveUserTmuxKeys()
  const unbinds: (readonly string[])[] = []
  if (userKeys.overridden.has(TMUX_FOCUS_ID)) {
    for (const chord of TMUX_FOCUS_DEFAULTS) {
      const t = chordToTmuxKey(chord)
      if ("key" in t) unbinds.push(["unbind-key", "-n", t.key])
    }
  }
  for (const id of userKeys.overridden) {
    if (id === TMUX_FOCUS_ID) continue
    const def = TMUX_SINGLE_BINDING_DEFAULTS[id as keyof typeof TMUX_SINGLE_BINDING_DEFAULTS]
    const t = chordToTmuxKey(def)
    if ("key" in t) unbinds.push(["unbind-key", "-n", t.key])
  }
  const focusDirections = ["-L", "-D", "-U", "-R"] as const
  const focusBinds = userKeys.focus.flatMap((bind, i) => {
    const dir = focusDirections[i]
    return bind && dir ? [["bind-key", "-n", bind.key, "select-pane", dir] as const] : []
  })
  const b = userKeys.binds
  await runTmuxSequence([
    ["set-option", "-g", "status", "on"],
    ["set-window-option", "-g", "aggressive-resize", "on"],
    ["set-option", "-g", "monitor-activity", "on"],
    ["set-option", "-g", "visual-activity", "off"],
    ["set-option", "-g", "window-status-format", CHAT_TAB_STATUS_FORMAT],
    ["set-option", "-g", "window-status-current-format", CHAT_TAB_STATUS_CURRENT_FORMAT],
    [
      "set-option",
      "-g",
      "status-right",
      kobeStatusRight({
        focusLeft: userKeys.focus[0]?.key ?? null,
        detach: b["tmux.detach"]?.key ?? null,
        newTab: b["tmux.tab.new"]?.key ?? null,
      }),
    ],
    ["set-option", "-g", "mouse", "on"],
    ["set-hook", "-g", "window-resized", healLayoutTmuxCommand],
    ...unbinds,
    // Two-stage: on the Tasks pane → detach (the old exit); anywhere else →
    // focus the current window's Tasks pane first. `#{@kobe_role}` is the
    // active pane's role tag.
    ...(b["tmux.detach"]
      ? [
          [
            "bind-key",
            "-n",
            b["tmux.detach"].key,
            "if-shell",
            "-F",
            "#{==:#{@kobe_role},tasks}",
            "detach-client",
            focusTasksTmuxCommand,
          ] as const,
        ]
      : []),
    ...focusBinds,
    ...(b["tmux.tab.new"] ? [["bind-key", "-n", b["tmux.tab.new"].key, "run-shell", newChatTabCommand] as const] : []),
    ...(b["tmux.tab.chooseEngine"]
      ? chatTabChooseEngineBindings(b["tmux.tab.chooseEngine"].key).map(
          (binding) => [...binding, chooseEngineTmuxCommand] as const,
        )
      : []),
    ...(b["tmux.tab.prev"] && b["tmux.tab.next"]
      ? chatTabSwitchBindings(b["tmux.tab.prev"].key, b["tmux.tab.next"].key)
      : b["tmux.tab.prev"]
        ? [["bind-key", "-n", b["tmux.tab.prev"].key, "previous-window"] as const]
        : b["tmux.tab.next"]
          ? [["bind-key", "-n", b["tmux.tab.next"].key, "next-window"] as const]
          : []),
    ...(b["tmux.tab.close"] ? [chatTabCloseBinding(b["tmux.tab.close"].key)] : []),
    ...(b["tmux.tab.rename"] ? [chatTabRenameBinding(b["tmux.tab.rename"].key)] : []),
    ["bind-key", "f", "run-shell", `${envStr}${invStr} quick-create --session '#{session_name}'`],
  ])

  // Theme-matched pane borders. The border tmux would otherwise use
  // (stock default, or a user tmux.conf gray) disappears against dark
  // kobe themes; derive both border styles from the active theme
  // instead. Precedence + the off-switch live in tmux-border-theme.ts.
  await applyTmuxPaneBorderTheme()

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])

  // Per-repo first prompt: deliver it AFTER the engine wakes, on this
  // FRESH session only (this is the create path — reuse/respawn never
  // reach here). Fire-and-forget so building the session doesn't block on
  // the engine's boot; the helper waits for readiness then pastes.
  const initPrompt = opts.initPrompt?.trim()
  if (initPrompt) {
    void deliverFirstPrompt(opts.name, initPrompt).catch((err) =>
      console.error("[kobe tmux] init prompt delivery failed:", err),
    )
  }
  return true
}

/**
 * Focus the active window's Tasks pane. The first stage of two-stage
 * Ctrl+Q (`kobe focus-tasks`): the if-shell binding only reaches this when
 * the active pane is NOT already the Tasks pane, so this is an
 * unconditional select. No-op when the session is gone or the active window
 * has no tagged Tasks pane (legacy session). Returns the pane id it
 * selected, or `""`.
 */
export async function selectTasksPane(session: string): Promise<string> {
  if (!(await sessionExists(session))) return ""
  const tasksPane = await paneIdByRole(session, "tasks")
  if (!tasksPane) return ""
  await runTmux(["select-pane", "-t", tasksPane])
  return tasksPane
}
