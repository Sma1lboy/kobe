import { describe, expect, it } from "vitest"
import { requestTabOpen, tabActivationListeners, takeTabOpen } from "../../src/tui-react/workspace/terminal-tabs-shared"

describe("tab-open pending request", () => {
  it("notifies listeners and is consumed once, by the right task", () => {
    let fired = 0
    const listener = () => {
      fired += 1
    }
    tabActivationListeners.add(listener)
    try {
      requestTabOpen("task-a", ["sh", "-lc", "true"], "demo")
      expect(fired).toBe(1)
      // The wrong task consumes nothing; the pending request survives.
      expect(takeTabOpen("task-b")).toBeNull()
      expect(takeTabOpen("task-a")).toMatchObject({ argv: ["sh", "-lc", "true"], title: "demo" })
      // Consumed exactly once.
      expect(takeTabOpen("task-a")).toBeNull()
    } finally {
      tabActivationListeners.delete(listener)
    }
  })
})
