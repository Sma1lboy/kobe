/**
 * The herdr "seen" bit behind the sidebar's unread lamp (● → ✓).
 *
 * Lives on the render track because `row-cards.tsx` pulls in opentui, which
 * vitest's node environment can't load.
 */

import { describe, expect, it } from "bun:test"
import { completionSeenFor } from "../../src/tui-react/panes/sidebar/row-cards"

describe("completionSeenFor", () => {
  it("digests to seen once you view the completed row, and stays seen after you leave", () => {
    const task = "task-seen-1"
    // Not viewing yet: the lamp stays unread.
    expect(completionSeenFor(task, "turn_complete", false)).toBe(false)
    // You open it while complete — same render already reads as digested.
    expect(completionSeenFor(task, "turn_complete", true)).toBe(true)
    // Leaving must NOT relight it: you have seen this completion.
    expect(completionSeenFor(task, "turn_complete", false)).toBe(true)
  })

  it("clears when that row's activity moves off turn_complete", () => {
    const task = "task-seen-2"
    completionSeenFor(task, "turn_complete", true)
    completionSeenFor(task, "running", false)
    // A NEW completion is unread again — the bit tracks the current turn.
    expect(completionSeenFor(task, "turn_complete", false)).toBe(false)
  })

  // Regression (owner report 2026-08-10): "I go in and it shows read, but as
  // soon as I leave it goes back to unread." A task's tab rows all render in
  // one pass; a sibling tab legitimately carries no activity, and with a
  // task-wide key its clear branch wiped the bit the completed tab had just
  // recorded — so the ✓ never survived leaving the row.
  it("a sibling tab of the same task does not wipe the completed tab's seen bit", () => {
    const task = "task-seen-3"
    expect(completionSeenFor(task, "turn_complete", true, "tab-1")).toBe(true)
    // tab-2 renders in the same pass with no activity of its own.
    completionSeenFor(task, undefined, false, "tab-2")
    expect(completionSeenFor(task, "turn_complete", false, "tab-1")).toBe(true)
  })

  it("keeps per-tab completions independent", () => {
    const task = "task-seen-4"
    completionSeenFor(task, "turn_complete", true, "tab-1")
    // tab-2 completes too, but you have not looked at IT.
    expect(completionSeenFor(task, "turn_complete", false, "tab-2")).toBe(false)
    expect(completionSeenFor(task, "turn_complete", false, "tab-1")).toBe(true)
  })

  // Regression (owner report 2026-08-12, issue #22): quitting kobe empties
  // this Set while the DAEMON keeps reporting the same `turn_complete`, so a
  // relaunch re-lit every completion already read. A fresh process is exactly
  // this: nothing in the Set, and the persisted mark as the only witness.
  it("a completion the persisted mark covers is read on a fresh process", () => {
    const task = "task-seen-5"
    expect(completionSeenFor(task, "turn_complete", false, "tab-1", true)).toBe(true)
    // A NEWER completion has a stamp the mark doesn't cover, so the durable
    // answer arrives false and the lamp is unread again.
    expect(completionSeenFor(task, "turn_complete", false, "tab-1", false)).toBe(false)
  })
})
