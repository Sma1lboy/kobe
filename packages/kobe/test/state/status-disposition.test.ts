/**
 * Pins the Symphony fail-safe (refs/symphony SPEC.md §14.4): a status value
 * this build does not recognize must PARK — stop work, preserve the
 * worktree — never launch an engine ("active") or reclaim state
 * ("terminal"). The known-value table itself is not enumerated here
 * (implementation-mirroring); only the behaviors that could silently break.
 */

import { statusDisposition } from "@sma1lboy/kobe-daemon/daemon/status-disposition"
import { describe, expect, test } from "vitest"

describe("statusDisposition", () => {
  test("unknown statuses fall back to parked, never active or terminal", () => {
    for (const weird of ["blocked", "DONE", "", "in-review", "42"]) {
      expect(statusDisposition(weird)).toBe("parked")
    }
  })

  test("shared vocabulary: hold parks like in_review; done is terminal in both stores", () => {
    expect(statusDisposition("hold")).toBe(statusDisposition("in_review"))
    expect(statusDisposition("done")).toBe("terminal")
  })
})
