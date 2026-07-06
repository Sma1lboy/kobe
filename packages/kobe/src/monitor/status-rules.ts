/**
 * Daemon-side status rules (docs/design/web-kanban.md M5, revised
 * 2026-06-11: the small-model judge was dropped in favor of rule + agent
 * self-report).
 *
 * The one rule that needs no judgment: an engine STARTING a turn on a
 * `backlog` task means work has begun — `turn-start` is unambiguous, so a
 * pure rule advances the card to `in_progress`. The other half of the flow
 * (in_progress → in_review) is the agent's own self-report via the injected
 * status protocol (engine/interactive-command.ts `withStatusProtocol`); the
 * agent knows whether it finished, no external classifier needed.
 *
 * Guardrails (the auto-done incident is the cautionary tale): the ONLY
 * transition this rule makes is `backlog → in_progress`. A task the user
 * placed anywhere else is never touched, so dragging a card back to
 * Backlog mid-session sticks until the engine's NEXT turn starts. Opt-in
 * via state.json `experimental.autoStatus`, read per event.
 */

import { autoStatusEnabled } from "@/state/auto-status"
import type { Task, TaskStatus } from "@/types/task"

/** The minimal orchestrator surface the rule needs (structural, so tests
 *  fake it and the daemon passes the real Orchestrator). */
export interface StatusRuleOrchestrator {
  getTask(id: string): Task | undefined
  setStatus(id: string, status: TaskStatus): Promise<void>
}

export type AutoStatusResult = "moved" | "skipped"

/**
 * `turn-start` rule: a backlog task whose engine starts working moves to
 * `in_progress`. Pure field checks — no git, no model, no transcript.
 */
export async function maybeAutoStart(
  orch: StatusRuleOrchestrator,
  taskId: string,
  enabled: () => boolean = autoStatusEnabled,
): Promise<AutoStatusResult> {
  if (!enabled()) return "skipped"
  const task = orch.getTask(taskId)
  if (!task) return "skipped"
  if ((task.kind ?? "task") === "main" || task.archived) return "skipped"
  if (task.status !== "backlog") return "skipped"
  await orch.setStatus(taskId, "in_progress")
  return "moved"
}
