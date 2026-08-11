/**
 * The engine-activity reducer + its policy constants/types — the pure half
 * of the daemon activity registry, split out of `activity-registry.ts`
 * (file-size cap). Moved verbatim; `activity-registry.ts` re-exports the
 * public names so existing importers keep one entry point.
 */

import type { EngineActivityDetail, EngineActivityKind, TaskActivityState } from "./contracts.ts"

export function reduceActivity(
  previous: TaskActivityState | undefined,
  kind: EngineActivityKind,
  detail?: EngineActivityDetail,
): TaskActivityState {
  switch (kind) {
    case "session-start":
    case "session-end":
    // Kimi fires Interrupt INSTEAD of Stop on a user interrupt.
    case "turn-interrupted":
      return "idle"
    case "turn-start":
      return "running"
    case "turn-complete":
      // Only a TRACKED turn completes: running, or blocked on the user
      // mid-turn (an approved permission resumes without a new turn-start).
      // Engines fire Stop on automated wakes too — a background monitor
      // stream ending "completed" a turn nobody started and lit the ●
      // lamp (owner bug 2026-08-02); that signature is a Stop on a KNOWN
      // untracked state (explicit idle/sticky entry) and stays swallowed.
      // `undefined` is a COLD registry (fresh daemon after a restart) — the
      // one real way a task's first event is a Stop is a turn that started
      // before the wipe, so let it complete instead of eating the ● lamp.
      // Mirrors kobe's hook-events reducer.
      return previous === "running" || previous === "permission_needed" || previous === undefined
        ? "turn_complete"
        : previous
    case "turn-failed":
      return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
    case "awaiting-input":
      // Permission prompt OR a question dialog — either way the engine is
      // blocked on the user (`detail.waiting` keeps which). Mirrors
      // kobe/src/engine/hook-events.ts.
      return "permission_needed"
    default:
      // Lifecycle-only kinds never reach the registry (the handler gates on
      // affectsActivityState); a direct call is a state no-op.
      return previous ?? "idle"
  }
}

/** How long a non-idle, non-complete engine-activity state survives with no
 *  follow-up event before lapsing to idle (safety net for a missed Stop/SessionEnd). */
export const DEFAULT_ENGINE_STATE_TTL_MS = 10 * 60 * 1000

/**
 * States that persist until the NEXT real hook event clears them, rather than
 * lapsing to idle on a stale liveness probe. `running` is the only state the
 * lapse watchdog polices (a missed Stop pinning it forever); every other
 * non-idle state is terminal-until-next-event:
 *
 *   - `turn_complete` keeps its checkmark until the next activity.
 *   - `permission_needed` / `error` / `rate_limited` are exactly the states a
 *     user leaves the session to attend to. The liveness probe is the transcript
 *     mtime, and an engine BLOCKED on a permission prompt / rate limit / error
 *     writes nothing — so the probe always reads "stale" and the old watchdog
 *     idled precisely the tasks that needed a human, hiding the ? badge after
 *     ~10min. They clear naturally: an approved turn emits Stop → turn_complete,
 *     an exit emits SessionEnd → idle, and clearTask() / task deletion wipe them.
 */
export const STICKY_STATES: ReadonlySet<TaskActivityState> = new Set([
  "turn_complete",
  "permission_needed",
  "error",
  "rate_limited",
])

export function resolveEngineStateTtlMs(): number {
  const raw = process.env.KOBE_ENGINE_STATE_TTL_MS
  if (raw === undefined) return DEFAULT_ENGINE_STATE_TTL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ENGINE_STATE_TTL_MS
}

/**
 * Liveness probe: latest engine-transcript mtime (epoch ms) for a task, or
 * `undefined` when it can't be determined (unknown task, no worktree, probe
 * error). Used by the lapse watchdog to tell a genuinely-silent engine (a
 * missed Stop ⇒ idle) apart from a long single turn that is still writing
 * tool output to its transcript (alive ⇒ keep the badge, re-arm). Filesystem-
 * only; never throws (a rejection is treated as `undefined` ⇒ lapse).
 *
 * `completedAt` is the newest turn-COMPLETION marker in the same transcript.
 * Mtime alone answers "is anything still being written", which is NOT the
 * question the watchdog is asking: an engine sitting idle at its prompt keeps
 * touching its transcript, so a missed Stop re-armed the watchdog forever and
 * the spinner never stopped. A completion at/after the last write means the
 * last thing that happened WAS the turn ending, so the badge must drop.
 */
export interface ActivityLiveness {
  /** Newest transcript mtime (epoch ms), or undefined when unknown. */
  readonly mtimeMs?: number
  /** Newest turn-completion marker timestamp (epoch ms), if any. */
  readonly completedAt?: number
}

/**
 * `vendor` is the REPORTING engine's id (the hook's `--engine`), when the
 * entry being policed carries one. A task whose configured vendor is a
 * custom wrapper id (`claudecpa` → cc-switch → claude) has no transcript
 * store under that id — probing by task.vendor read mtime 0 forever, so
 * every long turn lapsed to idle at the TTL while the engine was mid-turn.
 * The hook knows what actually runs; the probe must ask about THAT.
 */
export type ActivityLivenessProbe = (
  taskId: string,
  vendor?: string,
  /** The policed entry's own session transcript, when the hook piped one —
   *  lets the probe scope to THIS session instead of the whole worktree. */
  transcriptPath?: string,
) => Promise<ActivityLiveness | undefined>

/** The reporting engine's own session identity (from its hook payload). */
export interface EngineSessionInfo {
  readonly id: string
  readonly transcriptPath?: string
}
