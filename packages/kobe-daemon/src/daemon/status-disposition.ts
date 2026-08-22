/**
 * Status → disposition classification (framework-free, both stores).
 *
 * Kanban column names are presentation; what the orchestrator actually needs
 * to know about a status is one of three answers (the Symphony model,
 * refs/symphony SPEC.md §14.4):
 *
 *   - "active"   — the engine should run.
 *   - "parked"   — stop work, but PRESERVE the worktree.
 *   - "terminal" — stop work, the worktree is reclaimable.
 *
 * Covers both status vocabularies: Task ("backlog" | "in_progress" |
 * "in_review" | "done" | "canceled" | "error", see contracts.ts) and Issue
 * ("open" | "doing" | "hold" | "done", see issues-store.ts) — `hold` is the
 * issue-side spelling of in_review.
 */

export type StatusDisposition = "active" | "parked" | "terminal"

const DISPOSITIONS: Record<string, StatusDisposition> = {
  // TaskStatus
  backlog: "active",
  in_progress: "active",
  in_review: "parked",
  error: "parked",
  done: "terminal",
  canceled: "terminal",
  // IssueStatus (done shared above)
  open: "active",
  doing: "active",
  hold: "parked",
}

/**
 * FAIL-SAFE: a status this build does not recognize is `parked`, never
 * `active` or `terminal`. Acting on a misread must stop work and preserve
 * state — it must not launch an engine or reclaim a worktree.
 */
export function statusDisposition(status: string): StatusDisposition {
  return DISPOSITIONS[status] ?? "parked"
}
