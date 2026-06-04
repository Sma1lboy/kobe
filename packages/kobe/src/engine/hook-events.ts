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
  "awaiting-input",
  "session-end",
] as const
export type EngineActivityKind = (typeof ENGINE_ACTIVITY_KINDS)[number]

export function isEngineActivityKind(v: string): v is EngineActivityKind {
  return (ENGINE_ACTIVITY_KINDS as readonly string[]).includes(v)
}

/** Optional normalized detail an adapter can attach (read from the hook's stdin payload). */
export interface EngineActivityDetail {
  /** For `turn-failed`: a normalized failure class. */
  readonly failure?: "rate_limit" | "billing" | "other"
  /** For `awaiting-input`: why the engine is blocked. */
  readonly waiting?: "permission" | "input"
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
 *   awaiting-input (permission)    → permission_needed
 *   awaiting-input (input)         → running   (still mid-turn, just blocked on input)
 *   session-end                    → idle
 */
export function reduceActivity(
  _prev: TaskActivityState | undefined,
  kind: EngineActivityKind,
  detail?: EngineActivityDetail,
): TaskActivityState {
  switch (kind) {
    case "session-start":
    case "session-end":
      return "idle"
    case "turn-start":
      return "running"
    case "turn-complete":
      return "turn_complete"
    case "turn-failed":
      return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
    case "awaiting-input":
      return detail?.waiting === "permission" ? "permission_needed" : "running"
  }
}
