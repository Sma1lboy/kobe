/**
 * Shared task chips — the PR lifecycle chip and uncommitted-change counts
 * used by the task rail (AppShell) and the kanban Board so the two render
 * identically (the activity.ts "never drift" precedent).
 */

import { prChipView } from "../lib/pr-chip.ts"
import type { TaskPRStatus } from "../lib/types.ts"

export function ChangesChip({
  counts,
}: {
  counts: { added: number; deleted: number } | undefined
}) {
  if (!counts || (counts.added === 0 && counts.deleted === 0)) return null
  return (
    <span className="shrink-0 font-mono text-[10px]">
      <span className="text-kobe-green">+{counts.added}</span>{" "}
      <span className="text-kobe-red">−{counts.deleted}</span>
    </span>
  )
}

/** PR lifecycle/check → a short chip + theme color. Hidden when there's no
 *  PR (lifecycle unknown/none). Precedence rules live in lib/pr-chip.ts
 *  (pure, unit-tested) so the rail, the board, and the Overview never drift. */
export function PrChip({ pr }: { pr: TaskPRStatus | undefined }) {
  const view = prChipView(pr)
  if (!view) return null
  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${view.cls}`}
      title={view.title}
    >
      {view.label}
    </span>
  )
}

/** Conflict-radar ⚠ badge — red for a proven merge conflict, yellow for a
 *  file overlap, with a tooltip naming the counterpart(s). The simple
 *  `title`-tooltip variant shared by the rail and the Overview (the board's
 *  own ConflictBadge portals its tooltip to escape the column scroll-clip).
 *  Pass the lib/board.ts conflictBadge summary + conflictTip text. */
export function ConflictChip({
  badge,
}: {
  badge: { level: "overlap" | "conflict"; count: number; tip: string } | null
}) {
  if (!badge) return null
  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${
        badge.level === "conflict" ? "text-kobe-red" : "text-kobe-yellow"
      }`}
      title={badge.tip}
    >
      ⚠{badge.count}
    </span>
  )
}
