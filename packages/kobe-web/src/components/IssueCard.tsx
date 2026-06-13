/**
 * IssueCard — a compact, clickable card for one daemon issue, in the Board's
 * kanban-card grammar (title, #id, created date, hover footer of status moves +
 * quick start). Extracted from IssuesPage so the unified Board can render the
 * repo's issues in its Backlog column without the IssuesPage shell.
 *
 * Props in, callbacks out: the card owns no data fetching. `onOpen` is the
 * click handler that opens the issue drawer (IssuePeek). Issue cards are NOT
 * draggable — interaction is the drawer, not drag (unlike task cards).
 */

import { Play } from "lucide-react"
import {
  canQuickStart,
  type Issue,
  type IssueStatus,
  STATUS_META,
  statusActions,
} from "../lib/issues.ts"
import { TIP_ABOVE } from "./chips.tsx"

export function IssueCard({
  issue,
  busy,
  quickStartBusy,
  onSetStatus,
  onQuickStart,
  onOpen,
}: {
  issue: Issue
  busy: boolean
  quickStartBusy: boolean
  onSetStatus: (to: IssueStatus) => void
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
      {/* Hover bar: status moves + quick start. Overlays the card footer on
          hover only (the Board card grammar). */}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1 border-t border-line bg-surface px-2 py-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/card:opacity-100">
        {statusActions(issue.status).map((action) => (
          <button
            key={action.to}
            type="button"
            disabled={busy}
            onClick={() => onSetStatus(action.to)}
            title={`Move to ${STATUS_META[action.to].title}`}
            className="px-1 text-[10px] text-subtle transition-colors hover:text-fg disabled:opacity-40"
          >
            {action.label}
          </button>
        ))}
        {canQuickStart(issue.status) && (
          <button
            type="button"
            disabled={quickStartBusy}
            onClick={onQuickStart}
            aria-label={`Quick start issue #${issue.id}`}
            data-tip="Quick start — spawn a kobe task"
            className={`relative ml-auto flex h-5 w-5 items-center justify-center border border-line bg-surface text-subtle hover:border-primary hover:text-fg disabled:opacity-40 ${TIP_ABOVE}`}
          >
            <Play size={11} strokeWidth={1.8} />
          </button>
        )}
      </div>
    </div>
  )
}
