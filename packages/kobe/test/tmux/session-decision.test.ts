import { describe, expect, test } from "vitest"
import { type ObservedSession, type TargetSession, decideSessionAction } from "../../src/tmux/session-decision.ts"

function healthy(overrides: Partial<ObservedSession> = {}): ObservedSession {
  return {
    worktree: "/wt/task-a",
    vendor: "claude",
    claudePaneAlive: true,
    windowCount: 1,
    ...overrides,
  }
}

function target(overrides: Partial<TargetSession> = {}): TargetSession {
  return { cwd: "/wt/task-a", vendor: "claude", hasEngineCommand: true, ...overrides }
}

describe("decideSessionAction", () => {
  test("no session → create", () => {
    const action = decideSessionAction(null, target())
    expect(action.kind).toBe("create")
    expect(action.reason).toBeTruthy()
  })

  test("healthy + right worktree + right vendor → reuse", () => {
    const action = decideSessionAction(healthy(), target())
    expect(action.kind).toBe("reuse")
    expect(action.reason).toBeTruthy()
  })

  test("caller without a vendor accepts any tagged vendor → reuse", () => {
    const action = decideSessionAction(healthy({ vendor: "codex" }), target({ vendor: undefined }))
    expect(action.kind).toBe("reuse")
  })

  test("healthy session with an untagged vendor matching a vendor-less target → reuse", () => {
    const action = decideSessionAction(healthy({ vendor: "" }), target({ vendor: undefined }))
    expect(action.kind).toBe("reuse")
  })

  test("worktree drift → rebuild, even with a live engine pane and matching vendor", () => {
    const action = decideSessionAction(healthy({ worktree: "/wt/other" }), target())
    expect(action.kind).toBe("rebuild")
    expect(action.reason).toContain("/wt/other")
  })

  test("legacy session with no @kobe_worktree tag → rebuild", () => {
    const action = decideSessionAction(healthy({ worktree: "" }), target())
    expect(action.kind).toBe("rebuild")
  })

  test("vendor drift with a launch command → respawn-engine, not rebuild", () => {
    const action = decideSessionAction(healthy({ vendor: "claude" }), target({ vendor: "codex" }))
    expect(action.kind).toBe("respawn-engine")
    expect(action.reason).toContain("codex")
  })

  test("vendor drift respawns even when the ACTIVE window's engine pane is dead", () => {
    const action = decideSessionAction(
      healthy({ vendor: "claude", claudePaneAlive: false, windowCount: 3 }),
      target({ vendor: "codex" }),
    )
    expect(action.kind).toBe("respawn-engine")
  })

  test("vendor drift takes precedence over degraded multi-window reuse", () => {
    const action = decideSessionAction(healthy({ vendor: "codex", windowCount: 2 }), target({ vendor: "claude" }))
    expect(action.kind).toBe("respawn-engine")
  })

  test("vendor drift WITHOUT a launch command → rebuild", () => {
    const action = decideSessionAction(
      healthy({ vendor: "claude" }),
      target({ vendor: "codex", hasEngineCommand: false }),
    )
    expect(action.kind).toBe("rebuild")
  })

  test("vendor drift AND worktree drift → rebuild (respawn is right-place only)", () => {
    const action = decideSessionAction(
      healthy({ vendor: "claude", worktree: "/wt/other" }),
      target({ vendor: "codex" }),
    )
    expect(action.kind).toBe("rebuild")
  })

  test("dead engine pane, single window → rebuild", () => {
    const action = decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 1 }), target())
    expect(action.kind).toBe("rebuild")
  })

  test("dead engine pane, multiple windows → reuse (protect sibling chat tabs)", () => {
    const action = decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 2 }), target())
    expect(action.kind).toBe("reuse")
    expect(action.reason).toContain("sibling")
  })

  test("disposable-pane closure never reads as broken (claudePaneAlive is the only health input)", () => {
    const action = decideSessionAction(healthy({ claudePaneAlive: true }), target())
    expect(action.kind).toBe("reuse")
  })

  test("every action carries a non-empty human-readable reason", () => {
    const cases: ReturnType<typeof decideSessionAction>[] = [
      decideSessionAction(null, target()),
      decideSessionAction(healthy(), target()),
      decideSessionAction(healthy({ vendor: "claude" }), target({ vendor: "codex" })),
      decideSessionAction(healthy({ worktree: "/wt/other" }), target()),
      decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 1 }), target()),
      decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 2 }), target()),
    ]
    for (const action of cases) {
      expect(action.reason.length).toBeGreaterThan(0)
    }
  })
})
