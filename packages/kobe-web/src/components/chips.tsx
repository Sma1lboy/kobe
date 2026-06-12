/**
 * Shared task chips — the PR lifecycle chip and uncommitted-change counts
 * used by the task rail (AppShell) and the kanban Board so the two render
 * identically (the activity.ts "never drift" precedent).
 */

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
 *  PR (lifecycle unknown/none). Mirrors the daemon's TaskPRStatus shape. */
export function PrChip({ pr }: { pr: TaskPRStatus | undefined }) {
  const lifecycle = pr?.lifecycle
  if (!pr || !lifecycle || lifecycle === "unknown") return null
  const check = pr.checkState
  const cls =
    lifecycle === "merged"
      ? "text-kobe-violet"
      : lifecycle === "closed"
        ? "text-kobe-red"
        : check === "failing"
          ? "text-kobe-red"
          : check === "passing"
            ? "text-kobe-green"
            : check === "pending"
              ? "text-kobe-yellow"
              : "text-kobe-blue"
  const label = pr.number ? `PR #${pr.number}` : "PR"
  return (
    <span
      className={`shrink-0 font-mono text-[10px] ${cls}`}
      title={`${lifecycle}${check && check !== "none" ? ` · ${check}` : ""}`}
    >
      {label}
    </span>
  )
}
