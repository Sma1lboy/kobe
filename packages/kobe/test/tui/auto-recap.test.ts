/**
 * Unit tests for the auto-recap decision predicate exported from
 * `use-chat-session.ts`. The predicate is pure; the surrounding Solid
 * effect just calls `orchestrator.generateRecap` when it returns true.
 *
 * The conditions under test (mirroring the comment block above the
 * effect):
 *   - never fires on first-ever entry to a tab (no prior `seenAt`)
 *   - waits at least `RECAP_AUTO_TRIGGER_MS` since we left
 *   - requires the message count to have grown while we were away
 *   - skips when the tab is currently streaming (manual `/recap`
 *     still works mid-stream; the auto path defers)
 */

import { describe, expect, test } from "vitest"
import { RECAP_AUTO_TRIGGER_MS, shouldAutoRecap } from "../../src/tui/panes/chat/use-chat-session.ts"

const NOW = 1_700_000_000_000

describe("shouldAutoRecap", () => {
  test("first-ever tab entry (no seenAt) → no auto recap", () => {
    expect(
      shouldAutoRecap({
        seenAt: undefined,
        now: NOW,
        snapshotMessageCount: 0,
        liveMessageCount: 5,
        isStreaming: false,
      }),
    ).toBe(false)
  })

  test("returns within the cooldown window → no auto recap", () => {
    expect(
      shouldAutoRecap({
        seenAt: NOW - 60_000, // 1 minute ago
        now: NOW,
        snapshotMessageCount: 1,
        liveMessageCount: 10,
        isStreaming: false,
      }),
    ).toBe(false)
  })

  test("returns after the cooldown but nothing changed → no auto recap", () => {
    expect(
      shouldAutoRecap({
        seenAt: NOW - (RECAP_AUTO_TRIGGER_MS + 1000),
        now: NOW,
        snapshotMessageCount: 7,
        liveMessageCount: 7,
        isStreaming: false,
      }),
    ).toBe(false)
  })

  test("returns after the cooldown and message count grew → auto recap", () => {
    expect(
      shouldAutoRecap({
        seenAt: NOW - (RECAP_AUTO_TRIGGER_MS + 1000),
        now: NOW,
        snapshotMessageCount: 3,
        liveMessageCount: 14,
        isStreaming: false,
      }),
    ).toBe(true)
  })

  test("tab is currently streaming → no auto recap (manual /recap can still fire)", () => {
    expect(
      shouldAutoRecap({
        seenAt: NOW - (RECAP_AUTO_TRIGGER_MS + 1000),
        now: NOW,
        snapshotMessageCount: 3,
        liveMessageCount: 14,
        isStreaming: true,
      }),
    ).toBe(false)
  })

  test("returns exactly at the cooldown threshold → auto recap (boundary inclusive)", () => {
    expect(
      shouldAutoRecap({
        seenAt: NOW - RECAP_AUTO_TRIGGER_MS,
        now: NOW,
        snapshotMessageCount: 0,
        liveMessageCount: 1,
        isStreaming: false,
      }),
    ).toBe(true)
  })
})
