/**
 * Unit tests for the auto-recap predicate exported from
 * `use-chat-session.ts`. The Solid effect that arms / cancels the
 * timer is itself a thin wrapper; the only branching logic that
 * benefits from headless coverage is `hasRecapSinceLastUserTurn`,
 * which mirrors Claude Code's `hasSummarySinceLastUserTurn`
 * (`refs/claude-code/src/hooks/useAwaySummary.ts:16-23`) and decides
 * whether to skip the recap when one is already pinned to the
 * current user-turn window.
 */

import { describe, expect, test } from "vitest"
import type { ChatRow } from "../../src/tui/panes/chat/store.ts"
import { hasRecapSinceLastUserTurn } from "../../src/tui/panes/chat/use-chat-session.ts"

const TS = "2026-05-18T10:00:00.000Z"

function user(text: string): ChatRow {
  return { kind: "user", text, ts: TS }
}
function assistant(text: string): ChatRow {
  return { kind: "assistant", text, ts: TS }
}
function recap(text: string): ChatRow {
  return { kind: "recap", text, ts: TS }
}
function system(text: string): ChatRow {
  return { kind: "system", text, ts: TS }
}

describe("hasRecapSinceLastUserTurn", () => {
  test("empty transcript → false", () => {
    expect(hasRecapSinceLastUserTurn([])).toBe(false)
  })

  test("transcript with no recap row → false", () => {
    expect(hasRecapSinceLastUserTurn([user("hi"), assistant("hello")])).toBe(false)
  })

  test("recap is the last row → true", () => {
    expect(hasRecapSinceLastUserTurn([user("hi"), assistant("hello"), recap("recap text")])).toBe(true)
  })

  test("recap appears before the last user message → false", () => {
    // user sent something new after the recap landed — the recap is
    // stale; another one is allowed.
    expect(
      hasRecapSinceLastUserTurn([user("first"), assistant("ok"), recap("recap"), user("second"), assistant("ok2")]),
    ).toBe(false)
  })

  test("ignores non-user / non-recap rows between the recap and the tail", () => {
    // system + assistant rows can sit AFTER the recap without making
    // it stale — only a user row resets the window.
    expect(hasRecapSinceLastUserTurn([user("hi"), recap("recap"), assistant("more"), system("info")])).toBe(true)
  })

  test("multiple recaps without an intervening user message still report true", () => {
    expect(hasRecapSinceLastUserTurn([user("hi"), assistant("ok"), recap("a"), recap("b")])).toBe(true)
  })
})
