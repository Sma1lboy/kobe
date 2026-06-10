/**
 * Pure create/reuse/respawn DECISION for a task's tmux session.
 *
 * `ensureSession` (`tui/panes/terminal/tmux.ts`) is unavoidably
 * imperative — it queries and mutates a real tmux server. But the
 * *policy* it encodes — when a found session is healthy enough to
 * reuse, when a vendor switch can be applied in place, when the only
 * safe move is kill + rebuild — is a pure function of already-queried
 * facts. Pulling it out here makes every branch unit testable without
 * a tmux server, the same seam `session-layout.ts` provides for pane
 * commands/sizes (this module decides WHAT to do; that one decides
 * what the panes RUN; `tmux.ts` applies both).
 *
 * Deliberately NOT part of the decision (they live in the applier):
 *   - `healTaskPaneWidths` / `healKobePaneVersions` — stale-pane-version
 *     respawns of the kobe-owned Tasks/Ops panes after an upgrade. They
 *     are post-processing applied on EVERY reuse/respawn outcome, not a
 *     branch of the create/reuse/rebuild choice, and they need their own
 *     per-window pane listing the decision never sees.
 *   - The `respawn-engine` → rebuild fallback. Whether an engine pane
 *     actually exists to respawn is only known after a session-wide pane
 *     listing at apply time; when none is found the applier falls back
 *     to a full rebuild (the pre-extraction code did the same via
 *     fall-through).
 *
 * Everything in this file is pure: same inputs → same action, no IO.
 */

/**
 * Facts about an existing tmux session, as already queried by the
 * applier. Plain data — the decision never talks to tmux itself.
 */
export interface ObservedSession {
  /** The session's `@kobe_worktree` tag; `""` when absent (legacy/pre-tag session). */
  readonly worktree: string
  /** The session's `@kobe_vendor` tag; `""` when absent. */
  readonly vendor: string
  /**
   * Does the ACTIVE window have a live `@kobe_role=claude` pane? This is
   * the load-bearing health signal — keyed off the role tag, NOT a raw
   * pane count, so closing a disposable shell/ops pane never reads as
   * "session broken" (KOB-244).
   */
  readonly claudePaneAlive: boolean
  /** Number of windows (chat tabs) in the session. */
  readonly windowCount: number
}

/** What the caller wants the session to be — derived from `EnsureSessionOpts`. */
export interface TargetSession {
  /** The task's worktree; must match the session's `@kobe_worktree` tag. */
  readonly cwd: string
  /**
   * The task's engine vendor. Optional like `EnsureSessionOpts.vendor`:
   * a caller that doesn't pin a vendor accepts whatever the session runs.
   */
  readonly vendor?: string
  /**
   * Was a non-empty engine command supplied (`opts.command.length > 0`)?
   * A vendor-drift respawn needs a launch line to respawn WITH; without
   * one the drifted session is rebuilt instead.
   */
  readonly hasEngineCommand: boolean
}

/**
 * What `ensureSession` should do, plus a human-readable `reason` for
 * logs/tests. Discriminated on `kind`:
 *
 *   - `create`          — no session; build fresh.
 *   - `reuse`           — leave the session running (then heal widths +
 *                         kobe-owned pane versions in the applier).
 *   - `respawn-engine`  — relaunch the engine pane in place in every
 *                         window (vendor switch, KOB-232). Applier falls
 *                         back to `rebuild` if no engine pane is found.
 *   - `rebuild`         — kill the session, then build fresh.
 */
export type SessionAction =
  | { readonly kind: "create"; readonly reason: string }
  | { readonly kind: "reuse"; readonly reason: string }
  | { readonly kind: "respawn-engine"; readonly reason: string }
  | { readonly kind: "rebuild"; readonly reason: string }

/**
 * Decide what to do with a (possibly absent) tmux session for a task.
 * Branch order is load-bearing and mirrors the pre-extraction
 * `ensureSessionImpl` exactly — this was a behavior-preserving lift, so
 * resist "improving" the policy here without a driving bug:
 *
 *   1. No session → create.
 *   2. Healthy + right place + right engine → reuse. We key health off
 *      the LOAD-BEARING claude pane's role tag in the active window,
 *      not a pane count — typing `exit` in the shell pane used to drop
 *      the count and nuke the live engine conversation (KOB-244).
 *   3. Vendor-only drift (right worktree, task switched engines via
 *      `setVendor`) with a launch command → respawn the engine pane IN
 *      PLACE in every window instead of kill-session, so the switch
 *      lands WITHOUT destroying sibling Ctrl+T chat tabs (KOB-232).
 *      Checked before the degraded-reuse branch and regardless of the
 *      active window's pane health — the respawn is session-wide.
 *   4. Right place + right engine but the active window's engine pane
 *      is gone, with sibling windows present → reuse anyway. A rebuild
 *      would drop those sibling chat tabs; per-window pane recreate is
 *      a future follow-up. (The common shell-exit case never gets here
 *      because the engine pane survives — KOB-244.)
 *   5. Otherwise rebuild: a legacy/pre-tag (v0.5/KOB-225) session, a
 *      wrong-PLACE session (different/empty `@kobe_worktree` — stale
 *      from before env+socket isolation, panes in the wrong dir/wrong
 *      KOBE_HOME), a vendor-drifted session with no command to respawn
 *      with, or a single-window session whose engine pane was
 *      destroyed. Rebuild over in-place repair because a stale session's
 *      pane 0 already runs an engine with whatever state the user has.
 */
export function decideSessionAction(observed: ObservedSession | null, target: TargetSession): SessionAction {
  if (observed === null) {
    return { kind: "create", reason: "no session with this name — build fresh" }
  }

  const worktreeOk = observed.worktree === target.cwd
  const vendorOk = !target.vendor || observed.vendor === target.vendor

  if (observed.claudePaneAlive && worktreeOk && vendorOk) {
    return { kind: "reuse", reason: "healthy: engine pane alive, worktree + vendor match" }
  }

  if (worktreeOk && !vendorOk && target.hasEngineCommand) {
    return {
      kind: "respawn-engine",
      reason:
        `vendor drift: session tagged ${observed.vendor === "" ? "<untagged>" : `"${observed.vendor}"`}, ` +
        `task wants "${target.vendor}" — relaunch engine pane in place (KOB-232)`,
    }
  }

  if (worktreeOk && vendorOk && observed.windowCount > 1) {
    return {
      kind: "reuse",
      reason: "active window's engine pane is gone but sibling chat tabs exist — reuse rather than drop them",
    }
  }

  if (!worktreeOk) {
    return {
      kind: "rebuild",
      reason:
        observed.worktree === ""
          ? "legacy session with no @kobe_worktree tag — rebuild in the right place"
          : `worktree drift: session tagged "${observed.worktree}", task wants "${target.cwd}" — rebuild`,
    }
  }
  if (!vendorOk) {
    return {
      kind: "rebuild",
      reason: "vendor drift but no engine command to respawn with — rebuild",
    }
  }
  return {
    kind: "rebuild",
    reason: "single-window session whose engine pane was destroyed — rebuild",
  }
}
