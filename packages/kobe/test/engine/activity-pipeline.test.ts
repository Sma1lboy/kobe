import { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import { describe, expect, it } from "vitest"
import type { TaskEngineState } from "../../src/client/remote-orchestrator.ts"
import { ClaudeHookAdapter, claudeVerbForHookEvent } from "../../src/engine/claude-code-local/hook-adapter.ts"
import { isEngineActivityKind } from "../../src/engine/hook-events.ts"
import { IN_PROGRESS_SPINNER, buildSidebarRowView } from "../../src/tui/panes/sidebar/row-view.ts"
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
    status: "backlog",
    archived: false,
    pinned: false,
    vendor: "claude",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task
}

function rowAfterClaudeHook(event: string, payload: Record<string, unknown>) {
  const verb = claudeVerbForHookEvent(event)
  if (!verb) throw new Error(`kobe installs no hook for Claude event ${event}`)
  expect(isEngineActivityKind(verb)).toBe(true)
  const detail = new ClaudeHookAdapter().activityDetailFromPayload(verb, payload)
  const bus = new DaemonEventBus()
  const registry = new DaemonActivityRegistry(bus, 60_000, () => 42)
  try {
    registry.report("task-1", verb, detail)
    const published = registry.snapshotByTask()["task-1"]
    expect(published).toBeDefined()
    const activity: TaskEngineState | undefined =
      published.state === "idle" ? undefined : { state: published.state, detail: published.detail, at: published.at }
    return buildSidebarRowView({
      task: task(),
      activity,
      live: false,
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
    expect(row.stateGlyph).toBe(IN_PROGRESS_SPINNER[0])
    expect(row.tone).toBe("primary")
    expect(row.subtitleText).toBe("feature/sidebar")
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

  it("session end: the row falls back to its lifecycle badge", () => {
    const row = rowAfterClaudeHook("SessionEnd", { cwd: "/repo/kobe/worktrees/sidebar" })
    expect(row.loading).toBe(false)
    expect(row.stateGlyph).toBe("○")
    expect(row.tone).toBe("textMuted")
  })
})
