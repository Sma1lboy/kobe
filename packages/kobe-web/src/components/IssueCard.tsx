/**
 * IssueCard — a compact, clickable card for one daemon issue, in the Board's
 * kanban-card grammar (title, #id, created date, hover Eye + Trash). Extracted
 * from IssuesPage so the unified Board can render the repo's issues in its
 * Backlog column without the IssuesPage shell.
 *
 * Props in, callbacks out: the card owns no data fetching. `onOpen` is the
 * click handler that opens the issue detail drawer (IssuePeek). Clicking the
 * card body or the hover Eye both open that drawer — the card never starts a
 * task itself; starting an issue happens inside the detail drawer. `onDelete`
 * raises a delete request (the Board gates it behind a ConfirmDialog before
 * touching the daemon store). Issue cards are NOT draggable.
 */

import { Eye, Trash2 } from "lucide-react"
import type { Issue } from "../lib/issues.ts"
import { TIP_ABOVE } from "./chips.tsx"

export function IssueCard({
  issue,
  onOpen,
  onDelete,
}: {
  issue: Issue
  onOpen: () => void
  /** Raise a delete request — the Board confirms before removing the record. */
  onDelete: () => void
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
      {/* Hover affordances, top-right — an Eye that opens the issue detail
          drawer (same as clicking the card body) and a Trash that raises a
          delete request (the Board confirms before touching the daemon store).
          The Board card grammar: hover reveals peek affordances, never a start
          button. */}
      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open issue #${issue.id}`}
          data-tip="Open issue detail"
          className={`relative flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg ${TIP_ABOVE}`}
        >
          <Eye size={11} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete issue #${issue.id}`}
          data-tip="Delete issue"
          className={`relative flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-kobe-red/50 hover:text-kobe-red ${TIP_ABOVE}`}
        >
          <Trash2 size={11} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  )
}
