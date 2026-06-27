/**
 * Pure poll-cadence math for the Ops pane (`tui/ops/host.tsx`). Extracted
 * into a standalone module because `host.tsx` imports `@opentui/*` render
 * assets (a `.scm` grammar file) that vitest can't load — so the backoff
 * curves live here, where they're directly unit-testable, and `host.tsx`
 * imports them. No IO, no Solid, no tmux: just numbers.
 */

import type { ChatTabTurnState } from "@/engine/turn-detector"

/**
 * `● new` badge poll cadence (local fallback only — when no daemon is
 * publishing `transcript.activity`). The probe (`latestTranscriptMtime`) is
 * NOT free: for claude it readdir's the worktree's transcript dir and stats
 * every `.jsonl` in it, and that dir grows unboundedly. So it ADAPTIVELY
 * backs off: poll at {@link ACTIVITY_POLL_MIN_MS} while the engine is
 * writing, and after {@link ACTIVITY_IDLE_RAMP_POLLS} unchanged reads ramp
 * the interval toward {@link ACTIVITY_POLL_MAX_MS} (an idle pane is the
 * common steady state). Any mtime advance snaps it back to the fast interval.
 */
export const ACTIVITY_POLL_MIN_MS = 2500
export const ACTIVITY_POLL_MAX_MS = 20000
/** Unchanged reads before each step up; the interval doubles per step. */
export const ACTIVITY_IDLE_RAMP_POLLS = 3

/** Fast floor for the turn-status capture-pane poll (mid-turn / fallback fixed cadence). */
export const TURN_STATUS_POLL_MS = 1500
/** Backed-off cap for the turn-status capture-pane poll when the shared transcript is quiescent. */
export const TURN_STATUS_POLL_MAX_MS = 6000

/**
 * Next activity-poll delay from the current one + how many consecutive reads
 * have seen no change: the fast floor while active, doubling toward the cap
 * once idle past the ramp threshold. Pure — unit-tested.
 */
export function nextActivityPollDelay(currentMs: number, idleStreak: number): number {
  if (idleStreak < ACTIVITY_IDLE_RAMP_POLLS) return ACTIVITY_POLL_MIN_MS
  return Math.min(currentMs * 2, ACTIVITY_POLL_MAX_MS)
}

/**
 * Next turn-status (capture-pane) poll delay in SHARED mode (the daemon
 * publishes transcript activity, so completion no longer comes from a local
 * JSONL read — only the tmux pane-quiescence hash does). Sibling of
 * {@link nextActivityPollDelay}.
 *
 * The capture-pane hash is the one thing that MUST stay in-process (the
 * daemon never touches tmux), but while the shared transcript is quiescent
 * AND we're not mid-turn there's nothing for the pane to show — so ramp the
 * interval up toward {@link TURN_STATUS_POLL_MAX_MS} to stop hammering
 * `capture-pane`. Snap back to {@link TURN_STATUS_POLL_MS} the instant the
 * shared transcript mtime advances (the engine wrote output → a pane change
 * is imminent) or while a turn is actively running. Fallback (no daemon)
 * keeps the fixed {@link TURN_STATUS_POLL_MS} cadence — this helper isn't
 * consulted there. Pure — unit-tested.
 */
export function nextTurnStatusPollDelay(
  currentMs: number,
  sharedMtimeAdvanced: boolean,
  published: ChatTabTurnState | null,
): number {
  if (sharedMtimeAdvanced) return TURN_STATUS_POLL_MS
  if (published === "running") return TURN_STATUS_POLL_MS
  return Math.min(currentMs * 2, TURN_STATUS_POLL_MAX_MS)
}
