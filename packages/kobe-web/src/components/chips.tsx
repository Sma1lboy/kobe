/**
 * Shared task chips — the PR lifecycle chip and uncommitted-change counts
 * used by the task rail (AppShell) and the kanban Board so the two render
 * identically (the activity.ts "never drift" precedent).
 */

import type { TaskPRStatus } from "../lib/types.ts"

/** Instant hover tooltip rendered from the data-tip attribute — the native
 *  `title` takes a beat to appear, and one-glyph buttons need names. Shared
 *  by the Board and Issues cards so the recipe never drifts. */
export const TIP_ABOVE =
  "after:pointer-events-none after:absolute after:right-0 after:bottom-full after:z-10 after:mb-1 after:hidden after:whitespace-nowrap after:border after:border-line after:bg-menu after:px-1.5 after:py-0.5 after:text-[10px] after:text-fg after:content-[attr(data-tip)] hover:after:block"
export const TIP_RIGHT =
  "after:pointer-events-none after:absolute after:left-full after:top-2 after:z-10 after:ml-1 after:hidden after:whitespace-nowrap after:border after:border-line after:bg-menu after:px-1.5 after:py-0.5 after:text-[10px] after:text-fg after:content-[attr(data-tip)] hover:after:block"

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
