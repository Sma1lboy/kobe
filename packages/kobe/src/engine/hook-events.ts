/**
 * Engine-neutral activity-event vocabulary + state reducer.
 *
 * kobe learns "what is this task's engine doing right now" from engine HOOKS
 * (Claude Code's Stop / StopFailure / Notification / Session*; Codex's
 * hooks.json equivalents later). Each engine's {@link EngineHookAdapter}
 * translates its vendor-specific hook into one of these NORMALIZED verbs and
 * shells out to `kobe hook <verb>` (cwd-based; the daemon maps it to a task).
 * Everything downstream —
 * the `kobe hook` CLI, the daemon, the TUI — speaks only this neutral
 * vocabulary, so no vendor strings leak past the adapter (CLAUDE.md
 * "Engine-owned UI data").
 *
 * This module is pure (no I/O), so the reducer is unit-tested in isolation.
 */

/** The normalized hook verbs a `kobe hook <verb>` invocation carries. */
export const ENGINE_ACTIVITY_KINDS = [
  "session-start",
  "turn-start",
  "turn-complete",
  "turn-failed",
  "turn-interrupted",
  "awaiting-input",
  "session-end",
  // Lifecycle-only verbs (docs/design/plugin-events.md): forwarded to plugin
  // event hooks but NOT folded into the activity badge state.
  "tool-pre",
  "tool-post",
  "tool-failed",
  "pre-compact",
  "post-compact",
  "subagent-start",
  "subagent-stop",
] as const
export type EngineActivityKind = (typeof ENGINE_ACTIVITY_KINDS)[number]

export function isEngineActivityKind(v: string): v is EngineActivityKind {
  return (ENGINE_ACTIVITY_KINDS as readonly string[]).includes(v)
}

/** The subset that changes the task's activity STATE (badge + inbox). The
 *  rest are lifecycle observations plugins subscribe to; publishing them as
 *  engine-state would spam every client on every tool call. */
export const ACTIVITY_STATE_KINDS = [
  "session-start",
  "turn-start",
  "turn-complete",
  "turn-failed",
  "turn-interrupted",
  "awaiting-input",
  "session-end",
] as const satisfies readonly EngineActivityKind[]

export function affectsActivityState(kind: string): boolean {
  return (ACTIVITY_STATE_KINDS as readonly string[]).includes(kind)
}

/** Optional normalized detail an adapter can attach (read from the hook's stdin payload). */
export interface EngineActivityDetail {
  /** For `turn-failed`: a normalized failure class. */
  readonly failure?: "rate_limit" | "billing" | "other"
  /** For `awaiting-input`: why the engine is blocked. */
  readonly waiting?: "permission" | "input"
  /** For `tool-*`: normalized tool identity (vendor field spellings die here). */
  readonly tool?: { readonly name?: string; readonly id?: string }
  /** For `pre-compact`/`post-compact`: what triggered the compaction. */
  readonly compact?: { readonly trigger?: "manual" | "auto" }
  /** For `subagent-*`: which nested agent. */
  readonly subagent?: { readonly type?: string; readonly id?: string }
  /** Free-form human note (e.g. the raw error type), shown in tooltips. */
  readonly note?: string
}

/**
 * The per-task activity state the daemon publishes and the sidebar renders.
 * Distinct from the lifecycle {@link import("../types/task").TaskStatus}
 * (which is user-driven): this is transient, engine-driven liveness.
 */
export const TASK_ACTIVITY_STATES = [
  "idle",
  "running",
  "turn_complete",
  "rate_limited",
  "permission_needed",
  "error",
] as const
export type TaskActivityState = (typeof TASK_ACTIVITY_STATES)[number]

/**
 * Pure state machine: fold a normalized event into the next activity state.
 *   session-start                  → idle
 *   turn-start                     → running
 *   turn-complete                  → turn_complete
 *   turn-failed (rate_limit/billing)→ rate_limited
 *   turn-failed (other)            → error
 *   awaiting-input                 → permission_needed (permission prompt OR a
 *                                    question dialog — either way the engine is
 *                                    blocked on the user; `detail.waiting` keeps why)
 *   session-end                    → idle
 */
export function reduceActivity(
  prev: TaskActivityState | undefined,
  kind: EngineActivityKind,
  detail?: EngineActivityDetail,
): TaskActivityState {
  switch (kind) {
    case "session-start":
    case "session-end":
    // Kimi fires Interrupt INSTEAD of Stop on a user interrupt — without
    // this the turn strands in `running` (docs/design/plugin-events.md §B).
    case "turn-interrupted":
      return "idle"
    case "turn-start":
      return "running"
    case "turn-complete":
      // A completion is only a completion when a turn was actually in
      // flight: running, or blocked on the user mid-turn (an approved
      // permission continues WITHOUT a new turn-start). Engines fire Stop
      // for automated wakes too — a background monitor stream ending
      // "completes" a turn the user never started, and the ● lamp lit for
      // it (owner bug 2026-08-02). Without a tracked turn, keep what was.
      return prev === "running" || prev === "permission_needed" ? "turn_complete" : (prev ?? "idle")
    case "turn-failed":
      return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
    case "awaiting-input":
      return "permission_needed"
    default:
      // Lifecycle-only kinds never reach here via the daemon (gated by
      // affectsActivityState); a direct call is a no-op on the state.
      return prev ?? "idle"
  }
}
