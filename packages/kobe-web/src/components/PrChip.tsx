/**
 * PR lifecycle/check → a short chip + theme color, shared by the task rail
 * and the Overview cards. Hidden when there's no PR (lifecycle unknown/none).
 * View logic lives in lib/pr-chip.ts (pure, unit-tested).
 */

import { prChipView } from "../lib/pr-chip.ts"
import type { TaskPRStatus } from "../lib/types.ts"

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
