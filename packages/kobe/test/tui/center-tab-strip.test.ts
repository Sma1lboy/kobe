import { chatTabMarkerKind } from "@/tui/component/center-tab-strip-parts"
import { describe, expect, test } from "vitest"

describe("chatTabMarkerKind", () => {
  test("uses a leading success marker for completed background tabs", () => {
    expect(chatTabMarkerKind({ runState: undefined, unreadKind: "done", isPrimary: false })).toBe("unread_done")
  })

  test("suppresses unread markers on the primary visible tab", () => {
    expect(chatTabMarkerKind({ runState: undefined, unreadKind: "done", isPrimary: true })).toBeNull()
  })

  test("live run-state wins over stale unread state", () => {
    expect(chatTabMarkerKind({ runState: "running", unreadKind: "done", isPrimary: false })).toBe("running")
    expect(chatTabMarkerKind({ runState: "awaiting_input", unreadKind: "done", isPrimary: false })).toBe(
      "awaiting_input",
    )
  })
})
