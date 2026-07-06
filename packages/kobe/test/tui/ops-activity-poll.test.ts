import { describe, expect, it } from "vitest"
import {
  ACTIVITY_POLL_MAX_MS,
  ACTIVITY_POLL_MIN_MS,
  TURN_STATUS_POLL_MAX_MS,
  TURN_STATUS_POLL_MS,
  nextActivityPollDelay,
  nextTurnStatusPollDelay,
} from "../../src/tui/ops/activity-poll.ts"

describe("nextActivityPollDelay", () => {
  it("holds the fast floor while activity is fresh, ramps once idle past the threshold", () => {
    expect(nextActivityPollDelay(ACTIVITY_POLL_MIN_MS, 0)).toBe(ACTIVITY_POLL_MIN_MS)
    expect(nextActivityPollDelay(ACTIVITY_POLL_MIN_MS, 2)).toBe(ACTIVITY_POLL_MIN_MS)
    expect(nextActivityPollDelay(ACTIVITY_POLL_MIN_MS, 3)).toBe(ACTIVITY_POLL_MIN_MS * 2)
    expect(nextActivityPollDelay(ACTIVITY_POLL_MAX_MS, 9)).toBe(ACTIVITY_POLL_MAX_MS)
  })
})

describe("nextTurnStatusPollDelay", () => {
  it("snaps back to the fast floor the instant the shared transcript advances", () => {
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MAX_MS, true, "idle")).toBe(TURN_STATUS_POLL_MS)
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MAX_MS, true, "done")).toBe(TURN_STATUS_POLL_MS)
  })

  it("stays fast while a turn is actively running, even with no mtime advance", () => {
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MAX_MS, false, "running")).toBe(TURN_STATUS_POLL_MS)
  })

  it("ramps toward the cap while idle/done and the transcript is quiescent", () => {
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MS, false, "idle")).toBe(TURN_STATUS_POLL_MS * 2)
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MS * 2, false, "done")).toBe(TURN_STATUS_POLL_MAX_MS)
    expect(nextTurnStatusPollDelay(TURN_STATUS_POLL_MAX_MS, false, null)).toBe(TURN_STATUS_POLL_MAX_MS)
  })
})
