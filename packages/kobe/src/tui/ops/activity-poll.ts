import type { ChatTabTurnState } from "@/engine/turn-detector"

export const ACTIVITY_POLL_MIN_MS = 2500
export const ACTIVITY_POLL_MAX_MS = 20000
export const ACTIVITY_IDLE_RAMP_POLLS = 3

export const TURN_STATUS_POLL_MS = 1500
export const TURN_STATUS_POLL_MAX_MS = 6000

export function nextActivityPollDelay(currentMs: number, idleStreak: number): number {
  if (idleStreak < ACTIVITY_IDLE_RAMP_POLLS) return ACTIVITY_POLL_MIN_MS
  return Math.min(currentMs * 2, ACTIVITY_POLL_MAX_MS)
}

export function nextTurnStatusPollDelay(
  currentMs: number,
  sharedMtimeAdvanced: boolean,
  published: ChatTabTurnState | null,
): number {
  if (sharedMtimeAdvanced) return TURN_STATUS_POLL_MS
  if (published === "running") return TURN_STATUS_POLL_MS
  return Math.min(currentMs * 2, TURN_STATUS_POLL_MAX_MS)
}
