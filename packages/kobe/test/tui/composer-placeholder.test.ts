import { describe, expect, test } from "vitest"
import { resolvePlaceholder } from "../../src/tui/panes/chat/composer/placeholder"

describe("resolvePlaceholder", () => {
  test("keeps the streaming input placeholder blank", () => {
    expect(resolvePlaceholder({ hasTask: true, isStreaming: true })).toBe("")
  })

  test("shows the default idle prompt", () => {
    expect(resolvePlaceholder({ hasTask: true, isStreaming: false })).toBe("Ask Claude…")
  })

  test("shows the no-task fallback", () => {
    expect(resolvePlaceholder({ hasTask: false, isStreaming: false })).toBe("(no task — press n to create)")
  })
})
