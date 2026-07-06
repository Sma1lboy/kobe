/**
 * The "create a fresh session" half of `ensureSession` — split out of
 * `tmux-session.ts` (which was itself over the repo's 500-line file-size
 * cap once `ensureSessionImpl` moved there) into its own file. Same
 * behavior, moved verbatim: `createSession(opts)` is the exact tail of
 * the old `ensureSessionImpl`, called once `tmux-session.ts`'s
 * observe/decide dispatch falls through to rebuild-or-fresh.
 */

import { kobeCliInvocation } from "@/cli/invocation"
import { withClaudeSessionId, withDispatcherProtocol, withWorktreeProtocol } from "@/engine/interactive-command"
import { worktreeInitMarkerPath } from "@/env"
import { localSpawnCwd, remoteKeyForRepo } from "@/exec/resolve"
import { archivedHistoryPreviewEnabled } from "@/state/archived-history"
import { CHAT_TAB_SESSION_ID_OPTION, runTmux, runTmuxCapturing, runTmuxSequence, setWindowOption } from "@/tmux/client"
import { deliverFirstEngineMessage } from "@/tmux/prompt-delivery"
import {
  engineLaunchLine,
  engineTabExitCleanup,
  historyPaneKeepAlive,
  resolveRepoInitTimeoutSeconds,
  shellQuoteArgv,
} from "@/tmux/session-layout"
import { applyTmuxChromeTheme } from "@/tui/lib/tmux-border-theme"
import { buildPanesAround } from "./chattab"
import { REMOTE_KEY_OPTION, inheritedEnvPrefix, wrapEngineLaunch } from "./launch"
import { installSessionBindings } from "./tmux-session-bindings.ts"
import type { EnsureSessionOpts } from "./tmux-session.ts"
import { attachedWindowInfo, tmuxInitialSizeArgs } from "./tmux.ts"

/**
 * Create the session's first window with the claude pane, then build the
 * surrounding panes. Each pane command is passed as the trailing arg to
 * new-session / split-window — tmux runs it via its own `sh -c`, so we
 * hand it a single shell command STRING and skip send-keys (which
 * re-parses text and mangled the Ops `sh -c` quoting). Pane
 * ids (`%N`) are server-global and immune to `base-index`, so we always
 * target by id.
 */
export async function createSession(opts: EnsureSessionOpts): Promise<boolean> {
  const launchInit = opts.launchInit
  // The ONE remoteness derivation for this session build: a remote project's
  // key (`ssh://…`) or undefined for a local task. Everything below asks the
  // resolved host, never re-derives.
  const remoteKey = remoteKeyForRepo(opts.repo)
  const inv = kobeCliInvocation()
  // Archived task + beta gate (experimental.archivedHistoryPreview): replace
  // the live engine with the read-only `kobe history` pane. There's no agent
  // to instruct, so this path pins no engine session id and skips the init
  // script + status/dispatcher protocols below. Read fresh so a Settings
  // toggle needs no restart.
  const historyPreview = (opts.archived === true || opts.preview === true) && archivedHistoryPreviewEnabled()
  // Force a known session id for a claude launch so this window can be mapped
  // to its transcript and auto-named from its first prompt (KOB). No-op for
  // codex/copilot or a command that already pins its session. Skipped entirely
  // for the history preview (no live engine session).
  const launch = historyPreview
    ? { argv: [] as readonly string[], sessionId: undefined }
    : withClaudeSessionId(opts.command, opts.vendor)
  // Status self-report protocol (web-kanban.md M5): bake this task's id into
  // the session's system prompt so the agent can move its own card to
  // in_review when done. No-op unless experimental.autoStatus is on.
  // Excluded: MAIN sessions (worktreePath === repo is the main-task
  // invariant — project rows aren't board cards, and main's status heal
  // doesn't cover a stray in_review) and REMOTE tasks (the protocol's
  // `kobe api` would run on the remote host, where this daemon isn't).
  const isMainSession = opts.repo !== undefined && opts.cwd === opts.repo
  const protocolTaskId = isMainSession || remoteKey ? undefined : opts.taskId
  // Dispatcher protocol (docs/design/dispatcher.md): the exact complement —
  // only a LOCAL MAIN session gets the dispatcher seat. The taskId gates are
  // mutually exclusive by construction, so at most one protocol injects.
  const dispatcherTaskId = isMainSession && !remoteKey ? opts.taskId : undefined
  const launchArgv = withDispatcherProtocol(
    withWorktreeProtocol(launch.argv, opts.vendor, protocolTaskId),
    opts.vendor,
    dispatcherTaskId,
  )
  // The history preview launches `kobe history --worktree <wt> --vendor <v>`;
  // it reads the vendor transcript store by worktree path, so it renders even
  // when the worktree is gone. Otherwise the normal engine launch.
  // Remote task: the engine runs over SSH on the remote host (`ssh … 'cd <wt>
  // && <engine>'`), and the pane spawns in a LOCAL dir since the worktree is
  // remote. The repo's init script is deferred for remote (it runs locally
  // today — see docs/design/remote-projects.md phase 8), so it's skipped here.
  const historyArgv = [
    ...inv,
    "history",
    "--worktree",
    opts.archivedWorktree ?? opts.cwd,
    ...(opts.vendor ? ["--vendor", opts.vendor] : []),
    ...(opts.title ? ["--title", opts.title] : []),
    // Live preview of a non-archived task: tail the transcript + tag LIVE. An
    // archived task's transcript is frozen, so it stays the static ARCHIVED view.
    ...(opts.preview && !opts.archived ? ["--live"] : []),
  ]
  const engineCmd = wrapEngineLaunch(shellQuoteArgv(historyPreview ? historyArgv : launchArgv), remoteKey, opts.cwd)
  // The history preview is a PERSISTENT read-only pane: it re-launches itself on
  // exit (and ignores SIGINT) instead of following the engine pane's exit path,
  // which would drop to a shell and then spawn a LIVE engine via engine-tab-exit
  // — the one thing an archived-task preview must never do. The live engine path
  // keeps the per-repo init weave + engine-tab-exit cleanup verbatim.
  const paneCommand = historyPreview
    ? historyPaneKeepAlive(engineCmd)
    : engineLaunchLine(
        engineCmd,
        {
          initScript: remoteKey ? undefined : launchInit?.initScript,
          markerPath: !remoteKey && launchInit?.initScript ? worktreeInitMarkerPath(opts.cwd) : undefined,
          // Operator escape hatch for an unusually slow (or fast-fail) init —
          // clamped + defaulted by the resolver; unset keeps the 120s default.
          timeoutSeconds: resolveRepoInitTimeoutSeconds(process.env.KOBE_REPO_INIT_TIMEOUT_SECONDS),
        },
        // Exiting the post-engine fallback shell tears this tab down → close it
        // (or replace it with a fresh engine tab when it's the task's only tab).
        engineTabExitCleanup(inheritedEnvPrefix(), inv, opts.name),
      )
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
    paneCommand,
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

  // Size the window to the REAL terminal BEFORE splitting. When spawned from
  // inside a tmux pane (the Tasks-pane "open task" path), `new-session -x/-y`
  // above read this host's narrow pane stdout, so the window was born at the
  // rail width. Splitting at that tiny size bakes in a degenerate layout:
  // growing the window to the real client later (prepareWindowForSwitch) only
  // redistributes proportionally, so the fixed 32-cell rail balloons and every
  // pane ends up near-even (the "all panes the same size" cold-open bug). Fit
  // the still-detached window to the attached client's dims first so the splits
  // land at the right geometry. No-op outside tmux (direct.ts already created
  // the session at the real terminal size — process.stdout IS the terminal).
  if (process.env.TMUX) {
    const { sizeArgs } = await attachedWindowInfo()
    if (sizeArgs.length > 0) await runTmux(["resize-window", "-t", `=${opts.name}`, ...sizeArgs])
  }

  await buildPanesAround(pane0, {
    cwd: opts.cwd,
    taskId: opts.taskId,
    opsCommand: opts.opsCommand,
    inv,
    vendor: opts.vendor,
  })

  await installSessionBindings(inv)

  // Theme-matched tmux chrome. The tmux defaults (stock green status
  // bar, green active pane border, or a user's tmux.conf gray) clash
  // with kobe themes; derive the status/window bar, prompts, mode
  // selection, pane picker, and borders from the active theme instead.
  // Precedence + the off-switch live in tmux-border-theme.ts.
  await applyTmuxChromeTheme()

  // Focus the claude pane on first attach. Subsequent attaches keep
  // whatever pane tmux remembered — so a user who detached from Ops
  // lands back in Ops.
  await runTmux(["select-pane", "-t", pane0])

  // First engine message: deliver it AFTER the engine wakes, on this
  // FRESH session only (this is the create path — reuse/respawn never
  // reach here). Fire-and-forget so building the session doesn't block on
  // the engine's boot; the helper waits for readiness then pastes.
  const firstMessage = launchInit?.firstMessage
  if (firstMessage) {
    void deliverFirstEngineMessage(opts.name, firstMessage).catch((err) =>
      console.error("[kobe tmux] first message delivery failed:", err),
    )
  }
  return true
}
