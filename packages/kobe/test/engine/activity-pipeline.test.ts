/**
 * End-to-end activity vocabulary test (no socket) — pins the WHOLE hook
 * pipeline through every translation edge:
 *
 *   vendor hook event (Claude Code's `Stop` / `StopFailure` / …)
 *     → adapter install-time translation (event → neutral verb)
 *     → `kobe hook <verb>` gate (`isEngineActivityKind`)
 *     → adapter fire-time translation (stdin payload → neutral detail)
 *     → daemon reduce (`DaemonActivityRegistry` / `reduceActivity`)
 *     → `engine-state` payload → the `TaskEngineState` a sidebar row gets
 *     → `buildSidebarRowView` badge.
 *
 * The point: the neutral vocabulary (`EngineActivityKind` →
 * `TaskActivityState`, both in `engine/hook-events.ts`) is translated INTO
 * exactly once per hop — vendor names at the adapter, render glyphs at the
 * row — and a representative payload for each badge class survives the trip.
 * If any hop grows a private re-mapping, these assertions are where it shows.
 */

import { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { describe, expect, it } from "vitest"
import type { TaskEngineState } from "../../src/client/remote-orchestrator.ts"
import { ClaudeHookAdapter, claudeVerbForHookEvent } from "../../src/engine/claude-code-local/hook-adapter.ts"
import { isEngineActivityKind } from "../../src/engine/hook-events.ts"
import { buildSidebarRowView } from "../../src/tui/panes/sidebar/row-view.ts"
import type { Task } from "../../src/types/task.ts"
import { toTaskId } from "../../src/types/task.ts"

function task(): Task {
  return {
    id: toTaskId("task-1"),
    title: "fix sidebar",
    repo: "/repo/kobe",
    branch: "feature/sidebar",
    worktreePath: "/repo/kobe/worktrees/sidebar",
    kind: "task",
    status: "backlog", // neutral lifecycle so the badge comes purely from activity
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task
}

/** Run one vendor hook (event name + stdin payload) through every hop and
 *  return the sidebar row a task would render afterwards. */
function rowAfterClaudeHook(event: string, payload: Record<string, unknown>) {
  // 1. Install-time translation: Claude event name → neutral verb. This is
  //    what the adapter bakes into the `kobe hook <verb>` command it installs.
  const verb = claudeVerbForHookEvent(event)
  if (!verb) throw new Error(`kobe installs no hook for Claude event ${event}`)
  // 2. The `kobe hook` CLI gate: the verb on the wire must be a member of the
  //    one canonical kind vocabulary.
  expect(isEngineActivityKind(verb)).toBe(true)
  // 3. Fire-time translation: the vendor stdin payload → neutral detail
  //    (exactly what `runHookSubcommand` asks the hook-supporting adapters).
  const detail = new ClaudeHookAdapter().activityDetailFromPayload(verb, payload)
  // 4. Daemon side: `engine.reportEvent` lands in the activity registry,
  //    which reduces verb+detail to a TaskActivityState and publishes it.
  const bus = new DaemonEventBus()
  const registry = new DaemonActivityRegistry(bus, 60_000, () => 42)
  try {
    registry.report("task-1", verb, detail)
    const published = registry.snapshotByTask()["task-1"]
    expect(published).toBeDefined()
    // 5. Client side: RemoteOrchestrator accumulates non-idle states into
    //    TaskEngineState (an `idle` publish deletes the entry → undefined).
    const activity: TaskEngineState | undefined =
      published.state === "idle" ? undefined : { state: published.state, detail: published.detail, at: published.at }
    // 6. Render: the sidebar badge.
    return buildSidebarRowView({
      task: task(),
      activity,
      spinnerFrame: 0,
      subtitleBudget: 80,
      truncateBranch: (b) => b,
    })
  } finally {
    registry.close()
  }
}

describe("activity pipeline — vendor hook payload to sidebar badge", () => {
  it("turn running: UserPromptSubmit spins the row", () => {
    const row = rowAfterClaudeHook("UserPromptSubmit", { cwd: "/repo/kobe/worktrees/sidebar" })
    expect(row.loading).toBe(true)
    expect(row.stateGlyph).toBe(row.spinnerFrames[0])
    expect(row.tone).toBe("primary")
    expect(row.subtitleText).toBe("feature/sidebar") // running keeps the branch
  })

  it("turn done: Stop shows the checkmark", () => {
    const row = rowAfterClaudeHook("Stop", { cwd: "/repo/kobe/worktrees/sidebar" })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("✓")
    expect(row.tone).toBe("primary")
  })

  it("turn failed (rate limit): StopFailure error_type=rate_limit shows the clock badge", () => {
    const row = rowAfterClaudeHook("StopFailure", { error_type: "rate_limit" })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("◷")
    expect(row.tone).toBe("warning")
    expect(row.subtitleText).toBe("rate limited")
  })

  it("turn failed (billing classifies as rate-limited too)", () => {
    const row = rowAfterClaudeHook("StopFailure", { error_type: "billing_error" })
    expect(row.stateGlyph).toBe("◷")
    expect(row.subtitleText).toBe("rate limited")
  })

  it("turn failed (other): unknown error_type shows the error badge", () => {
    const row = rowAfterClaudeHook("StopFailure", { error_type: "hook_crashed" })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("✕")
    expect(row.tone).toBe("error")
    expect(row.subtitleText).toBe("error")
  })

  it("waiting on permission: the Notification permission hook shows the ? badge", () => {
    const row = rowAfterClaudeHook("Notification", {
      message: "Claude needs your permission to use Bash",
    })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("?")
    expect(row.tone).toBe("warning")
    expect(row.subtitleText).toBe("needs permission")
  })

  it("session end: the row returns to neutral runtime chrome", () => {
    const row = rowAfterClaudeHook("SessionEnd", { cwd: "/repo/kobe/worktrees/sidebar" })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("○")
    expect(row.tone).toBe("textMuted")
    expect(row.subtitleText).toBe("feature/sidebar")
  })
})
