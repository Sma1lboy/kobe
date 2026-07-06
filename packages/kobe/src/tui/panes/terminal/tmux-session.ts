/**
 * tmux session ensure — split out of `tmux.ts` (which was over the repo's
 * 500-line file-size cap) purely mechanically: same behavior, same
 * exports, moved verbatim. `tmux.ts` re-exports everything here so every
 * pre-split importer (hosts, CLI handlers, tests) keeps resolving these
 * from `panes/terminal/tmux`.
 *
 * This is the observe → decide → apply pipeline (`ensureSession`): reuse a
 * healthy session, respawn just the engine pane on a vendor switch, or
 * fall through to `createSession` (`tmux-session-create.ts`) to build a
 * fresh one. `createSession` in turn calls `installSessionBindings`
 * (`tmux-session-bindings.ts`) for the server-scoped tmux chrome/hooks/keys
 * — the create path outgrew this file too, hence the further split.
 */

import { remoteKeyForRepo } from "@/exec/resolve"
import type { EngineLaunchInit } from "@/state/repo-init"
import { killSession, runTmuxCapturing, sessionExists, setSessionOption } from "@/tmux/client"
import { type ObservedSession, decideSessionAction } from "@/tmux/session-decision"
import { healWorkspaceLayout, relaunchEngineInAllWindows } from "./pane-heal"
import { createSession } from "./tmux-session-create.ts"

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
   * Launch-time init/prompt contract for a FRESH session. The script is
   * woven before the engine in the same shell; the first message is pasted
   * after the engine is ready. No-op on pure reuse — only the create path
   * applies it. Resolve via {@link resolveEngineLaunchInit}.
   */
  readonly launchInit?: EngineLaunchInit
  /**
   * The task is archived. With `experimental.archivedHistoryPreview` on, the
   * create path launches `kobe history` (a read-only transcript view) into the
   * engine pane slot INSTEAD of the live engine — no engine session, no init
   * script, no status/dispatcher protocols. Absent/false keeps live-engine
   * behavior verbatim.
   */
  readonly archived?: boolean
  /**
   * The worktree PATH the archived history pane keys the vendor transcript
   * store by — distinct from {@link cwd} (where panes spawn) because a removed
   * worktree's dir is gone, so panes must spawn in a usable fallback dir while
   * history still reads the recorded path. Defaults to `cwd` when unset.
   */
  readonly archivedWorktree?: string
  /**
   * Live preview mode (per-task opt-in, same `experimental.archivedHistoryPreview`
   * beta gate as {@link archived}). Like archived it launches `kobe history` into
   * the engine pane slot INSTEAD of the live engine — but for a NON-archived task
   * whose worktree is live, so the pane tails the transcript (`--live`) and tags
   * itself LIVE rather than ARCHIVED. Absent/false keeps live-engine behavior.
   */
  readonly preview?: boolean
  /** Task title — passed to the `kobe history` header when archived. */
  readonly title?: string
}

/** Per-session-name in-flight lock — concurrent enters coalesce. */
const ensureSessionLocks = new Map<string, Promise<boolean>>()

/**
 * Ensure a detached session named `name` exists with the four-pane
 * layout. Returns `true` once the session is ready (reused or freshly
 * built), `false` if creation failed (so callers can avoid attaching to
 * a nonexistent session).
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

/**
 * The vendor a live session is ACTUALLY running, from its `@kobe_vendor`
 * tag — `null` when no session exists (or it carries no tag). Lets a launcher
 * reconcile a task's persisted vendor to reality before `ensureSession`, so a
 * stale persisted vendor can't trigger a destructive `respawn-engine` of a
 * healthy engine pane (e.g. a main task frozen at "claude" wiping a running
 * codex session on restart).
 */
export async function observeSessionVendor(name: string): Promise<string | null> {
  const observed = await observeSession(name)
  const v = observed?.vendor.trim()
  return v ? v : null
}

async function ensureSessionImpl(opts: EnsureSessionOpts): Promise<boolean> {
  // (Engine activity hooks are NOT installed here — they live in the user's
  // global ~/.claude/settings.json, installed once on launch by
  // `ensureGlobalKobeHooks`, and report their cwd so the daemon maps each event
  // to a task. No per-worktree write, so reuse/rebuild/fresh all behave the
  // same and a project's real repo root is never touched.)
  //
  // Observe → decide → apply. The WHY of each branch (pane-count
  // trap, sibling-tab preservation, legacy/pre-tag rebuilds) is
  // documented on `decideSessionAction`; this function only applies the
  // chosen action against the real tmux server.
  const observed = await observeSession(opts.name)
  const action = decideSessionAction(observed, {
    cwd: opts.cwd,
    vendor: opts.vendor,
    hasEngineCommand: opts.command.length > 0,
  })
  // The ONE remoteness derivation the reuse/respawn dispatch needs; `createSession`
  // derives its own copy independently (pure, cheap) for the fresh-build path.
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
  // --target-pane stays valid). Falls through to a full rebuild
  // when no engine pane is found to respawn — that fact is only knowable
  // here at apply time, so it's the applier's fallback, not the decision's.
  if (action.kind === "respawn-engine") {
    const relaunch = await relaunchEngineInAllWindows(opts.name, opts.cwd, opts.command, remoteKey, opts.vendor)
    if (relaunch === "switched") {
      // Advance the session's `@kobe_vendor` tag ONLY now that every window's
      // engine pane respawned on the new vendor — the tag is a single
      // session-scoped fact the Ops panes (and `decideSessionAction`) trust to
      // describe what's actually running, so a partial respawn must not move it.
      if (opts.vendor) await setSessionOption(opts.name, "@kobe_vendor", opts.vendor)
      // `vendorChanged` forces every window's Ops pane to respawn so its baked
      // `--vendor` flag (and the transcript store its activity badge + turn
      // detector poll) tracks the NEW engine — a same-version Ops pane would
      // otherwise keep polling the OLD vendor's store.
      await healWorkspaceLayout(opts.name, {
        cwd: opts.cwd,
        taskId: opts.taskId,
        vendor: opts.vendor,
        vendorChanged: true,
      })
      return true
    }
    if (relaunch === "respawn-failed") {
      // A respawn in some window failed (tmux already logged the error and
      // halted the sequence). The session still exists and is usable, so we
      // do NOT kill+rebuild — that would drop the sibling chat tabs the
      // in-place respawn exists to preserve. We also leave the prior
      // `@kobe_vendor` tag untouched rather than falsely claim the switch; the
      // tag still mismatching the task's vendor means the next `ensureSession`
      // re-enters this respawn branch and retries. Heal layout WITHOUT
      // `vendorChanged` so the Ops panes stay aligned with the tag we kept.
      await healWorkspaceLayout(opts.name, { cwd: opts.cwd, taskId: opts.taskId, vendor: opts.vendor })
      return true
    }
    // relaunch === "no-engine-pane" → fall through to the rebuild path below.
  }

  // Rebuild (or a respawn that found no engine pane): kill, then fall
  // through to the shared create path.
  if (action.kind === "rebuild" || action.kind === "respawn-engine") {
    await killSession(opts.name)
  }
  return createSession(opts)
}
