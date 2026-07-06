/**
 * Shared task chips — the PR lifecycle chip and uncommitted-change counts
 * used by the task rail (AppShell) and the kanban Board so the two render
 * identically (the activity.ts "never drift" precedent).
 */

import { prChipView } from "../lib/pr-chip.ts"
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
 *  PR (lifecycle unknown/none). Precedence rules live in lib/pr-chip.ts
 *  (pure, unit-tested) so the rail and the board never drift. */
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

/** Engine label chip — which engine (Claude / Codex / …) a task runs. The
 *  label is engine-owned (resolve via lib/engines.ts engineLabel); this is
 *  presentational only. Rendered by the rail ONLY when the workspace runs
 *  mixed engines (else it's the same word on every row). */
export function EngineChip({ label }: { label: string | null }) {
  if (!label) return null
  return (
    <span
      className="shrink-0 rounded-sm border border-line px-1 font-mono text-[9px] uppercase tracking-wide text-subtle"
      title={`engine: ${label}`}
    >
      {label}
    </span>
  )
}
