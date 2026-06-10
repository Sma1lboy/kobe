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
 * NOTE on the "kobe deliberately does NOT use tmux" rule in `pty.ts`:
 * that still holds for the legacy terminal-pane shell backend. tmux
 * is used here only for the interactive engine session, where
 * persistence + native attach are exactly what tmux is good at.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { worktreeInitMarkerPath } from "@/env"
import { execHostForRepo, localSpawnCwd, remoteKeyForRepo } from "@/exec/resolve"
import {
  CHAT_TAB_SESSION_ID_OPTION,
  claudePaneIdStrict,
  getSessionOptions,
  newWindow,
  paneIdByRole,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  runTmuxSequenceCapturing,
  sessionExists,
  setSessionOption,
  setWindowOption,
  windowCount,
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
import {
  CLAUDE_PANE_PERCENT,
  OPS_PANE_PERCENT,
  TASKS_PANE_WIDTH,
  engineLaunchLine,
  keepAlive,
  opsPaneCommand,
  shellQuote,
  shellQuoteArgv,
  tasksPaneCommand,
  updatePageCommand,
} from "@/tmux/session-layout"
import { applyTmuxPaneBorderTheme } from "@/tui/lib/tmux-border-theme"
import type { VendorId } from "@/types/task"
import { ALL_VENDORS } from "@/types/vendor"
import { CURRENT_VERSION } from "@/version"

// Re-export the shared identity/lifecycle helpers so existing importers
// (`app.tsx`, `LivePreview`, `fullscreen.tsx`) keep their `./tmux` path.
export {
  attachArgv,
  currentSessionName,
  killSession,
  sessionExists,
  switchClientBeforeKill,
  tmuxAvailable,
  tmuxSessionName,
} from "@/tmux/client"

// ChatTab binding builders. The KEY argument comes from the user-
// resolvable tmux key set (`resolveUserTmuxKeys` — defaults C-[ / C-] /
// C-w / F2); the COMMAND halves are fixed. Builders instead of consts so
// `~/.kobe/settings/keybindings.yaml` overrides flow through one place.
export function chatTabSwitchBindings(prevKey: string, nextKey: string) {
  return [
    ["bind-key", "-n", prevKey, "previous-window"],
    ["bind-key", "-n", nextKey, "next-window"],
  ] as const
}

export function chatTabCloseBinding(key: string) {
  return [
    "bind-key",
    "-n",
    key,
    "if-shell",
    "-F",
    "#{>:#{session_windows},1}",
    "kill-window",
    "display-message 'Cannot close the only ChatTab'",
  ] as const
}

export function chatTabRenameBinding(key: string) {
  return ["bind-key", "-n", key, "command-prompt", "-I", "#{window_name}", "rename-window -- '%%'"] as const
}

// The prompt names the built-ins as examples but ends with `…` so it doesn't
// imply a CLOSED list — users can register custom engines (Settings → Engines),
// and typing a registered custom id here is accepted (validated against
// `availableEngineIds()` in the `new-chattab` handler).
export const CHAT_TAB_ENGINE_PROMPT = `engine (${ALL_VENDORS.join("/")}/…)`

/** Session tag carrying a remote project's key (`ssh://…`) so chat tabs + the
 * vendor-switch respawn re-wrap the engine over SSH. Absent for local tasks. */
const REMOTE_KEY_OPTION = "@kobe_remote"

/**
 * Wrap a built engine command for the host the task's project resolves to:
 * a remote project's host wraps it over the multiplexed SSH connection
 * (`ssh -tt … 'cd <remoteWt> && <engine>'`); the local host's `wrapCommand`
 * is the identity (no `remoteKey`, or an `ssh://` key with no stored config,
 * which resolves local). `ensureReady` opens the ControlMaster once so the
 * pane's ssh reuses it with no re-auth (no secret in the pane command). See
 * `docs/design/remote-projects.md`.
 */
function wrapEngineLaunch(engineCmd: string, remoteKey: string | undefined, remoteCwd: string): string {
  if (!remoteKey) return engineCmd
  const host = execHostForRepo(remoteKey)
  host.ensureReady()
  return host.wrapCommand(engineCmd, { tty: true, cwd: remoteCwd })
}

// Engine-choice ChatTab bindings: the no-prefix chord is user-resolvable
// (default C-S-T); the `prefix T` fallback row stays fixed — it exists
// precisely for terminals that can't forward the shifted control chord.
export function chatTabChooseEngineBindings(key: string) {
  return [
    ["bind-key", "-n", key, "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
    ["bind-key", "T", "command-prompt", "-p", CHAT_TAB_ENGINE_PROMPT],
  ] as const
}

/** Compact display form of a tmux key for the status-right hint (`C-h` → `^h`). */
function tmuxKeyCap(key: string): string {
  return key.startsWith("C-") && key.length === 3 ? `^${key.slice(2)}` : key
}

/**
 * Minimal, muted `status-right` shown on the `-L kobe` socket. From inside the
 * engine/shell pane the user has no other on-screen hint for kobe's
 * escape-hatch chords, so we surface the three most useful ones. `^h` (the
 * focus-left key) returns to the Tasks pane (the two-stage Ctrl+Q first stage
 * is reachable from there), `^q` is the two-stage detach, `^t` opens a new
 * chat tab. Built from the RESOLVED key set so user overrides show their own
 * chords; an unbound key drops its segment. Dimmed with `fg=brightblack` so it
 * reads as a muted hint rather than fighting the user's theme; the trailing
 * space keeps it off the terminal's right edge.
 */
export function kobeStatusRight(keys: {
  focusLeft: string | null
  detach: string | null
  newTab: string | null
}): string {
  const segments = [
    keys.focusLeft ? `${tmuxKeyCap(keys.focusLeft)} tasks` : null,
    keys.detach ? `${tmuxKeyCap(keys.detach)} detach` : null,
    keys.newTab ? `${tmuxKeyCap(keys.newTab)} tab` : null,
  ].filter((s): s is string => s !== null)
  return `#[fg=brightblack]${segments.join("  ")} `
}

export const CHAT_TAB_STATE_OPTION = "@kobe_tab_state"
export const PANE_VERSION_OPTION = "@kobe_pane_version"
export const CHAT_TAB_STATUS_FORMAT =
  "#{?#{==:#{@kobe_tab_state},running},●,#{?#{==:#{@kobe_tab_state},done},✓,#{?#{==:#{@kobe_tab_state},error},!,#{?#{==:#{@kobe_tab_state},unknown},?,○}}}} #I:#W"
export const CHAT_TAB_STATUS_CURRENT_FORMAT = CHAT_TAB_STATUS_FORMAT

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
 * Snapshot the facts about an existing session that the reuse/respawn/
 * rebuild decision needs (`null` when no session exists). All read-only
 * tmux queries live here; the policy that consumes them is the pure
 * `decideSessionAction` in `tmux/session-decision.ts`. `windowCount` is
 * now queried up front (pre-extraction it was lazy, only fetched on the
 * degraded-reuse branch) — one extra read-only `list-windows` per
 * ensureSession, same decision either way.
 */
async function observeSession(name: string): Promise<ObservedSession | null> {
  if (!(await sessionExists(name))) return null
  const sessionOptions = await getSessionOptions(name, ["@kobe_worktree", "@kobe_vendor"])
  return {
    worktree: sessionOptions["@kobe_worktree"] ?? "",
    vendor: sessionOptions["@kobe_vendor"] ?? "",
    claudePaneAlive: (await claudePaneIdStrict(name)) !== "",
    windowCount: await windowCount(name),
  }
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
    await healTaskPaneWidths(opts.name)
    await healKobePaneVersions(opts.name, opts.cwd, opts.taskId, opts.vendor)
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
      await healTaskPaneWidths(opts.name)
      await healKobePaneVersions(opts.name, opts.cwd, opts.taskId, opts.vendor)
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
 * Relaunch the engine (claude/codex) pane in EVERY window of the session
 * in place via `respawn-pane`, preserving the windows and their other
 * panes (and each pane's id + `@kobe_role` tag, so the Ops pane's
 * `--target-pane` keeps pointing at a live pane). Returns `true` if at
 * least one engine pane was respawned, `false` if none was found (caller
 * then falls back to a full rebuild). Used to apply a vendor switch to a
 * multi-window session without `kill-session` dropping sibling chat tabs
 * (KOB-232).
 */
async function relaunchEngineInAllWindows(
  session: string,
  cwd: string,
  command: readonly string[],
  remoteKey?: string,
): Promise<boolean> {
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
  const cmd = keepAlive(wrapEngineLaunch(shellQuoteArgv(command), remoteKey, cwd))
  for (const pane of enginePanes) {
    // `-k` kills the old engine process; `-c` is the LOCAL spawn dir (the
    // worktree is remote for a remote task — the wrapped ssh carries `cd <wt>`).
    await runTmux(["respawn-pane", "-k", "-c", localSpawnCwd(cwd), "-t", pane, cmd])
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

type KobePaneRow = {
  windowId: string
  paneId: string
  role: string
  version: string
}

function parseKobePaneRows(stdout: string): KobePaneRow[] {
  const rows: KobePaneRow[] = []
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const [windowId, paneId, role, version] = line.split("\t")
    if (!windowId || !paneId || !role) continue
    rows.push({ windowId: windowId.trim(), paneId: paneId.trim(), role: role.trim(), version: version?.trim() ?? "" })
  }
  return rows
}

/**
 * kobe updates leave existing tmux sessions alive. That is correct for
 * engine panes (they may be mid-turn), but the Tasks/Ops panes are also
 * long-lived `kobe tasks` / `kobe ops` processes. If they keep running
 * the old binary, newly shipped shortcuts and file-pane behaviour appear
 * "missing" until the user manually resets tmux.
 *
 * Heal only kobe-owned panes: respawn Tasks/Ops in place when their pane
 * version tag is absent or stale. tmux preserves the pane id, so Ops can
 * keep targeting the same engine pane after its own restart; the engine
 * pane and all ChatTab windows stay alive.
 */
async function healKobePaneVersions(
  session: string,
  cwd: string,
  taskId: string | undefined,
  vendor: string | undefined,
): Promise<void> {
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}`,
  ])
  if (code !== 0) return

  const byWindow = new Map<string, KobePaneRow[]>()
  for (const row of parseKobePaneRows(stdout)) {
    const panes = byWindow.get(row.windowId) ?? []
    panes.push(row)
    byWindow.set(row.windowId, panes)
  }

  const commands: (readonly string[])[] = []
  for (const panes of byWindow.values()) {
    const claudePane = panes.find((pane) => pane.role === "claude")?.paneId
    const tasksPane = panes.find((pane) => pane.role === "tasks")
    const opsPane = panes.find((pane) => pane.role === "ops")

    if (tasksPane && tasksPane.version !== CURRENT_VERSION) {
      commands.push(
        [
          "respawn-pane",
          "-k",
          "-t",
          tasksPane.paneId,
          "-c",
          localSpawnCwd(cwd),
          keepAlive(envPrefix + tasksPaneCommand(inv, { initialTaskId: taskId })),
        ],
        ["set-option", "-p", "-t", tasksPane.paneId, "@kobe_role", "tasks"],
        ["set-option", "-p", "-t", tasksPane.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
      )
    }

    if (opsPane && claudePane && opsPane.version !== CURRENT_VERSION) {
      commands.push(
        [
          "respawn-pane",
          "-k",
          "-t",
          opsPane.paneId,
          "-c",
          localSpawnCwd(cwd),
          keepAlive(
            envPrefix +
              opsPaneCommand({
                cwd,
                taskId,
                claudePaneId: claudePane,
                cliInvocation: inv,
                vendor,
              }),
          ),
        ],
        ["set-option", "-p", "-t", opsPane.paneId, "@kobe_role", "ops"],
        ["set-option", "-p", "-t", opsPane.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
      )
    }
  }

  if (commands.length > 0) await runTmuxSequence(commands)
}

/**
 * Settings changes like transparent background are read by each kobe-owned
 * pane process at startup. After the full-window Settings page exits, the
 * existing Tasks/Ops panes in sibling ChatTabs are still alive, so respawn
 * only those helper panes in place to make the new UI prefs visible without
 * touching the user's engine or shell panes.
 */
export async function refreshKobeWorkspacePanes(session: string): Promise<void> {
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree", "@kobe_task", "@kobe_vendor"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const vendor = sessionOptions["@kobe_vendor"] || undefined
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const { code, stdout } = await runTmuxCapturing([
    "list-panes",
    "-s",
    "-t",
    `=${session}`,
    "-F",
    `#{window_id}\t#{pane_id}\t#{@kobe_role}\t#{${PANE_VERSION_OPTION}}`,
  ])
  if (code !== 0) return

  const byWindow = new Map<string, KobePaneRow[]>()
  for (const row of parseKobePaneRows(stdout)) {
    const panes = byWindow.get(row.windowId) ?? []
    panes.push(row)
    byWindow.set(row.windowId, panes)
  }

  const commands: (readonly string[])[] = []
  for (const panes of byWindow.values()) {
    const claudePane = panes.find((pane) => pane.role === "claude")?.paneId
    const tasksPane = panes.find((pane) => pane.role === "tasks")
    const opsPane = panes.find((pane) => pane.role === "ops")

    if (tasksPane) {
      commands.push(
        [
          "respawn-pane",
          "-k",
          "-t",
          tasksPane.paneId,
          "-c",
          localSpawnCwd(cwd),
          keepAlive(envPrefix + tasksPaneCommand(inv, { initialTaskId: taskId })),
        ],
        ["set-option", "-p", "-t", tasksPane.paneId, "@kobe_role", "tasks"],
        ["set-option", "-p", "-t", tasksPane.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
      )
    }

    // Respawn the Ops pane even when its window has no claude pane (a degraded
    // window whose engine pane was destroyed). We used to require `claudePane`
    // here, which SILENTLY skipped the Ops pane in such a window — so a
    // `kobe reload` left it on stale code with no feedback. `opsPaneCommand`
    // already degrades gracefully to its git-status fallback when there's no
    // claude pane to target, so respawning is always at least as good as
    // leaving the old process, and keeps "reload refreshes every pane" true.
    if (opsPane) {
      commands.push(
        [
          "respawn-pane",
          "-k",
          "-t",
          opsPane.paneId,
          "-c",
          localSpawnCwd(cwd),
          keepAlive(
            envPrefix +
              opsPaneCommand({
                cwd,
                taskId,
                claudePaneId: claudePane ?? null,
                cliInvocation: inv,
                vendor,
              }),
          ),
        ],
        ["set-option", "-p", "-t", opsPane.paneId, "@kobe_role", "ops"],
        ["set-option", "-p", "-t", opsPane.paneId, PANE_VERSION_OPTION, CURRENT_VERSION],
      )
    }
  }

  if (commands.length > 0) await runTmuxSequence(commands)

  // The Appearance prefs the respawned panes just re-read also drive the
  // tmux border colors — re-derive those in the same pass so a theme
  // switch restyles the pane separators without a new session build.
  await applyTmuxPaneBorderTheme()
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
    ["set-window-option", "-t", claudePane, CHAT_TAB_STATE_OPTION, "idle"],
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
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "tasks=#{pane_id}",
      keepAlive(envPrefix + tasksPaneCommand(args.inv, { initialTaskId: args.taskId })),
    ],
    [
      "split-window",
      "-h",
      "-t",
      claudePane,
      "-l",
      `${100 - CLAUDE_PANE_PERCENT}%`,
      "-c",
      localSpawnCwd(args.cwd),
      "-P",
      "-F",
      "ops=#{pane_id}",
      opsCmd,
    ],
    ["split-window", "-v", "-l", `${100 - OPS_PANE_PERCENT}%`, "-c", localSpawnCwd(args.cwd)],
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
    ...(ids.tasks ? ([["set-option", "-p", "-t", ids.tasks, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, "@kobe_role", "ops"]] as const) : []),
    ...(ids.ops ? ([["set-option", "-p", "-t", ids.ops, PANE_VERSION_OPTION, CURRENT_VERSION]] as const) : []),
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
  const sessionOptions = await getSessionOptions(session, [
    "@kobe_worktree",
    "@kobe_task",
    "@kobe_vendor",
    REMOTE_KEY_OPTION,
  ])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const taskId = sessionOptions["@kobe_task"] || undefined
  const remoteKey = sessionOptions[REMOTE_KEY_OPTION] || undefined
  const vendor = vendorOverride ?? (sessionOptions["@kobe_vendor"] as VendorId | undefined)
  if (vendorOverride) await rememberSessionVendor(session, taskId, vendorOverride)
  const command = interactiveEngineCommand(vendor)
  // Same forced-session-id mapping as the first window, so a Ctrl+T tab is
  // auto-named from its OWN first prompt (KOB).
  const launch = withClaudeSessionId(command, vendor)
  const inv = kobeCliInvocation()
  const r = await runTmuxCapturing([
    "new-window",
    "-t",
    `=${session}`,
    "-c",
    localSpawnCwd(cwd),
    "-P",
    "-F",
    "#{pane_id}",
    // Re-wrap the engine over SSH for a remote task's chat tab (same engine the
    // task launched with), reusing the project's ControlMaster connection.
    keepAlive(wrapEngineLaunch(shellQuoteArgv(launch.argv), remoteKey, cwd)),
  ])
  const claudePane = r.stdout.trim()
  if (!claudePane) return
  if (launch.sessionId) await setWindowOption(claudePane, CHAT_TAB_SESSION_ID_OPTION, launch.sessionId)
  await buildPanesAround(claudePane, { cwd, taskId, inv, vendor })
}

/**
 * Open the Settings page as a dedicated chat-tab window in an existing
 * task session (the default settings surface — see settings-surface.ts).
 * A single full-window `kobe settings` page (no engine, no workspace
 * panes), sitting alongside the engine chat tabs in the status-bar
 * window list. It is NOT `keepAlive`-wrapped: when the user closes
 * Settings (q / esc), the page process exits, tmux closes the window and
 * switches back to the previous tab. The `@kobe_*` tags aren't needed —
 * the page only reads/writes shared kv state, not a worktree.
 */
export async function openSettingsTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} settings`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "settings" })
}

/**
 * Open the new-task flow as a dedicated chat-tab window in an existing
 * task session (the `chattab` settings surface, mirroring
 * {@link openSettingsTab}). A single full-window `kobe new-task` page
 * that performs the create/adopt itself and exits — tmux then closes the
 * window and returns to the previous tab. `defaultRepo` pre-selects the
 * repo picker (the Tasks pane's cursor-task repo); the page falls back to
 * the first saved repo / cwd when it's omitted.
 */
export async function openNewTaskTab(session: string, defaultRepo?: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const repoArg = defaultRepo ? ` --repo ${shellQuote(defaultRepo)}` : ""
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} new-task${repoArg}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "new task" })
}

/**
 * Open update details as a dedicated tmux window. The Tasks pane footer
 * stays compact; the full page owns release notes, clickable actions,
 * and the terminal handoff for actually running the updater.
 */
export async function openUpdateTab(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${updatePageCommand({ cliInvocation: inv })}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "update" })
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
    const { connectOrStartDaemon } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
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

/**
 * Quick-create (`<prefix> f`): open the prompt-only quick-task page as a
 * dedicated chat-tab window (mirroring {@link openNewTaskTab}). The page
 * (`kobe quick-task`) asks for ONLY a prompt and fills repo / engine / base
 * branch from defaults derived from this session's task, then creates the
 * task + delivers the prompt and exits. Invoked by `kobe quick-create`,
 * which passes only the session name.
 */
export async function quickCreate(session: string): Promise<void> {
  if (!(await sessionExists(session))) return
  const sessionOptions = await getSessionOptions(session, ["@kobe_worktree"])
  const cwd = sessionOptions["@kobe_worktree"] || process.cwd()
  const inv = kobeCliInvocation()
  const envPrefix = inheritedEnvPrefix()
  const command = `${envPrefix}${inv.map(shellQuote).join(" ")} quick-task --session ${shellQuote(session)}`
  await newWindow(session, { cwd: localSpawnCwd(cwd), command, name: "quick task" })
}
