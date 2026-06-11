/**
 * PR chip view logic — maps a task's PR status to the short chip the rail
 * and the Overview cards render. Pure + React-free so the precedence rules
 * (terminal lifecycle beats check state) are unit-testable.
 */

import type { TaskPRStatus } from "./types.ts"

export interface PrChipView {
  label: string
  /** Theme text color class. */
  cls: string
  /** Hover title: lifecycle, plus the check state when meaningful. */
  title: string
}

/** null = render nothing (no PR, or lifecycle unknown). */
export function prChipView(pr: TaskPRStatus | undefined): PrChipView | null {
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
  return {
    label: pr.number ? `PR #${pr.number}` : "PR",
    cls,
    title: `${lifecycle}${check && check !== "none" ? ` · ${check}` : ""}`,
  }
}
