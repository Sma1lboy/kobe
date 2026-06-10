/**
 * Pure-policy tests for the tmux session create/reuse/respawn decision.
 *
 * `ensureSession` used to encode this tree inline against a live tmux
 * server, so every branch could only be verified interactively. These
 * tests pin the extracted policy (`tmux/session-decision.ts`) branch by
 * branch — each case names the production bug class it guards
 * (KOB-244 pane-count trap, KOB-232 sibling-tab destruction, stale
 * pre-isolation sessions). The applier-side halves (respawn fallback to
 * rebuild, width/pane-version healing) are runtime tmux behavior and
 * stay out of scope here.
 */

import { describe, expect, test } from "vitest"
import { type ObservedSession, type TargetSession, decideSessionAction } from "../../src/tmux/session-decision.ts"

/** A healthy, matching session — the baseline each case perturbs. */
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
    // The plain first-launch path: nothing to reuse, nothing to kill.
    const action = decideSessionAction(null, target())
    expect(action.kind).toBe("create")
    expect(action.reason).toBeTruthy()
  })

  test("healthy + right worktree + right vendor → reuse", () => {
    // THE persistence guarantee: a matching session survives detach and
    // a kobe restart instead of being rebuilt (losing the conversation).
    const action = decideSessionAction(healthy(), target())
    expect(action.kind).toBe("reuse")
    expect(action.reason).toBeTruthy()
  })

  test("caller without a vendor accepts any tagged vendor → reuse", () => {
    // `EnsureSessionOpts.vendor` is optional; a vendor-less caller must
    // not read a codex session as "wrong engine" and nuke it.
    const action = decideSessionAction(healthy({ vendor: "codex" }), target({ vendor: undefined }))
    expect(action.kind).toBe("reuse")
  })

  test("healthy session with an untagged vendor matching a vendor-less target → reuse", () => {
    // Legacy sessions built before vendor tagging carry "" — a caller
    // that doesn't pin a vendor still reuses them.
    const action = decideSessionAction(healthy({ vendor: "" }), target({ vendor: undefined }))
    expect(action.kind).toBe("reuse")
  })

  test("worktree drift → rebuild, even with a live engine pane and matching vendor", () => {
    // Wrong PLACE: a stale session from before env+socket isolation has
    // panes in the wrong dir / wrong KOBE_HOME. Reusing it would drop
    // the user into the wrong environment, so it must be rebuilt.
    const action = decideSessionAction(healthy({ worktree: "/wt/other" }), target())
    expect(action.kind).toBe("rebuild")
    expect(action.reason).toContain("/wt/other")
  })

  test("legacy session with no @kobe_worktree tag → rebuild", () => {
    // Pre-tag (v0.5/KOB-225) sessions tag nothing; "" never equals a
    // real cwd, so they always rebuild into the tagged shape.
    const action = decideSessionAction(healthy({ worktree: "" }), target())
    expect(action.kind).toBe("rebuild")
  })

  test("vendor drift with a launch command → respawn-engine, not rebuild", () => {
    // KOB-232: the task switched engines via `v`/setVendor. kill-session
    // would destroy every sibling Ctrl+T chat tab (each its own
    // conversation); respawn-pane applies the switch in place instead.
    const action = decideSessionAction(healthy({ vendor: "claude" }), target({ vendor: "codex" }))
    expect(action.kind).toBe("respawn-engine")
    expect(action.reason).toContain("codex")
  })

  test("vendor drift respawns even when the ACTIVE window's engine pane is dead", () => {
    // The respawn is session-WIDE (it lists engine panes in every
    // window), while claudePaneAlive is active-window scoped — so a dead
    // pane in the window the user happens to be on must not demote the
    // vendor switch to a kill-session.
    const action = decideSessionAction(
      healthy({ vendor: "claude", claudePaneAlive: false, windowCount: 3 }),
      target({ vendor: "codex" }),
    )
    expect(action.kind).toBe("respawn-engine")
  })

  test("vendor drift takes precedence over degraded multi-window reuse", () => {
    // Branch ORDER pin: with both vendor drift and sibling windows, the
    // pre-extraction code reached the respawn branch first. Flipping the
    // order would silently leave the OLD engine running after a switch.
    const action = decideSessionAction(healthy({ vendor: "codex", windowCount: 2 }), target({ vendor: "claude" }))
    expect(action.kind).toBe("respawn-engine")
  })

  test("vendor drift WITHOUT a launch command → rebuild", () => {
    // No engine command means nothing to respawn the panes with — the
    // pre-extraction code skipped the respawn and fell to kill-session.
    const action = decideSessionAction(
      healthy({ vendor: "claude" }),
      target({ vendor: "codex", hasEngineCommand: false }),
    )
    expect(action.kind).toBe("rebuild")
  })

  test("vendor drift AND worktree drift → rebuild (respawn is right-place only)", () => {
    // In-place respawn would keep panes spawned in the WRONG worktree;
    // only a session in the right place earns the gentle path.
    const action = decideSessionAction(
      healthy({ vendor: "claude", worktree: "/wt/other" }),
      target({ vendor: "codex" }),
    )
    expect(action.kind).toBe("rebuild")
  })

  test("dead engine pane, single window → rebuild", () => {
    // The active (only) window lost its tagged claude pane and there are
    // no sibling tabs to protect — kill + recreate is the correct repair.
    const action = decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 1 }), target())
    expect(action.kind).toBe("rebuild")
  })

  test("dead engine pane, multiple windows → reuse (protect sibling chat tabs)", () => {
    // KOB-244 family: kill-session would drop every sibling Ctrl+T chat
    // tab to fix one window's missing pane. Per-window recreate is a
    // future follow-up; until then the degraded window is tolerated.
    const action = decideSessionAction(healthy({ claudePaneAlive: false, windowCount: 2 }), target())
    expect(action.kind).toBe("reuse")
    expect(action.reason).toContain("sibling")
  })

  test("disposable-pane closure never reads as broken (claudePaneAlive is the only health input)", () => {
    // The original KOB-244 bug: `exit` in the shell pane dropped a raw
    // pane COUNT below threshold and nuked the live engine conversation.
    // The decision takes only the role-tagged claude pane's liveness, so
    // a session that lost its shell/ops pane (claude pane still alive)
    // is indistinguishable from healthy — and is reused.
    const action = decideSessionAction(healthy({ claudePaneAlive: true }), target())
    expect(action.kind).toBe("reuse")
  })

  test("every action carries a non-empty human-readable reason", () => {
    // Reasons feed logs and future doctor output; an empty string would
    // make a rebuild look arbitrary to the user.
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
