/**
 * IssueCard — a compact, clickable card for one daemon issue, in the Board's
 * kanban-card grammar (title, #id, created date, hover quick-start). Extracted
 * from IssuesPage so the unified Board can render the repo's issues in its
 * Backlog column without the IssuesPage shell.
 *
 * Props in, callbacks out: the card owns no data fetching. `onOpen` is the
 * click handler that opens the issue detail drawer (IssuePeek); `onQuickStart`
 * is the single one-click start (spawn a task on the default engine). The
 * status-move hover buttons are gone — moving an issue is the drawer's job, or
 * is implied by quick-starting it. Issue cards are NOT draggable.
 */

import { Play } from "lucide-react"
import { canQuickStart, type Issue } from "../lib/issues.ts"
import { TIP_ABOVE } from "./chips.tsx"

export function IssueCard({
  issue,
  quickStartBusy,
  onQuickStart,
  onOpen,
}: {
  issue: Issue
  quickStartBusy: boolean
  onQuickStart: () => void
  onOpen: () => void
}) {
  return (
    <div className="group/card relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col gap-1.5 border border-line bg-surface p-3 text-left transition-colors hover:border-primary hover:bg-inset"
      >
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10px] text-subtle">
            #{issue.id}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
            {issue.title}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-subtle">
          <span className="font-mono">{issue.created}</span>
        </div>
      </button>
      {/* One-click quick start, top-right, on hover (the Board card grammar).
          Click the card body itself to open the detail drawer. */}
      {canQuickStart(issue.status) && (
        <button
          type="button"
          disabled={quickStartBusy}
          onClick={onQuickStart}
          aria-label={`Quick start issue #${issue.id}`}
          data-tip="Quick start — spawn a kobe task"
          className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle opacity-0 transition-opacity hover:border-primary hover:text-fg focus-visible:opacity-100 disabled:opacity-40 group-hover/card:opacity-100 ${TIP_ABOVE}`}
        >
          <Play size={11} strokeWidth={1.8} />
        </button>
      )}
    </div>
  )
}
