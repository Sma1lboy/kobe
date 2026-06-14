/**
 * IssueCard — a compact, clickable card for one daemon issue, in the Board's
 * kanban-card grammar (title, #id, created date, hover Eye). Extracted from
 * IssuesPage so the unified Board can render the repo's issues in its Backlog
 * column without the IssuesPage shell.
 *
 * Props in, callbacks out: the card owns no data fetching. `onOpen` is the
 * click handler that opens the issue detail drawer (IssuePeek). Clicking the
 * card body or the hover Eye both open that drawer — the card never starts a
 * task itself; starting an issue happens inside the detail drawer. Issue cards
 * are NOT draggable.
 */

import { Eye } from "lucide-react"
import type { Issue } from "../lib/issues.ts"

export function IssueCard({
  issue,
  onOpen,
}: {
  issue: Issue
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
      {/* Single hover Eye, top-right — opens the issue detail drawer (same as
          clicking the card body). The Board card grammar: hover reveals one
          peek affordance, never a start button. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open issue #${issue.id}`}
        title="Open issue detail"
        className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle opacity-0 transition-opacity hover:border-primary hover:text-fg focus-visible:opacity-100 group-hover/card:opacity-100"
      >
        <Eye size={11} strokeWidth={1.8} />
      </button>
    </div>
  )
}
