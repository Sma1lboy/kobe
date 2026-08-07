/**
 * Column rendering for the issues board — one project's column row and the
 * per-column card list. Split from Board.tsx, which keeps the page frame,
 * filters, and the peek/intake/delete drawers.
 */

import { ExternalLink, Plus } from "lucide-react"
import type { BoardColumn, ProjectBoard } from "../lib/board.ts"
import { isLinkedIssue } from "../lib/board.ts"
import type { Issue } from "../lib/issues.ts"
import { IssueCard } from "./IssueCard.tsx"

function ColumnView({
  repo,
  column,
  onNewIssue,
  onPeekIssue,
  onOpenTask,
  onDeleteIssue,
}: {
  repo: string
  column: BoardColumn
  /** Backlog only — open the issue-intake panel scoped to this repo. */
  onNewIssue?: () => void
  onPeekIssue: (issue: Issue) => void
  /** Jump to a linked issue's task workspace/session. */
  onOpenTask: (taskId: string) => void
  /** Raise a delete request for an issue card — the Board confirms first. */
  onDeleteIssue: (issue: Issue) => void
}) {
  return (
    <section
      data-column={`${repo}:${column.key}`}
      className={`flex h-full shrink-0 flex-col border border-transparent ${
        column.key === "backlog" ? "w-96" : "w-72"
      }`}
    >
      <div className="mb-2 flex items-baseline gap-2">
        <h2
          className={`text-[11px] font-bold uppercase tracking-[0.12em] ${column.accent}`}
        >
          {column.title}
        </h2>
        <span className="font-mono text-[10px] text-subtle">
          {column.cards.length + column.hiddenCount}
        </span>
        {onNewIssue && (
          <button
            type="button"
            onClick={onNewIssue}
            className="ml-auto flex items-center gap-0.5 text-[10px] text-subtle transition-colors hover:text-fg"
            title="New story in this project"
          >
            <Plus size={11} strokeWidth={2} />
            <span>New story</span>
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-2">
        {column.cards.length === 0 ? (
          <div className="border border-dashed border-line-subtle p-3 text-center text-[11px] text-subtle">
            none
          </div>
        ) : (
          column.cards.map((card) => {
            const { issue } = card
            const linkedTaskId = isLinkedIssue(issue) ? issue.taskId : undefined
            return (
              <div key={`issue:${issue.id}`} className="group/wrap relative">
                <IssueCard
                  issue={issue}
                  onOpen={() => onPeekIssue(issue)}
                  onDelete={() => onDeleteIssue(issue)}
                />
                {/* Linked issue → a "started — open task" affordance that jumps
                    to the task's workspace. The task is not its own card; this
                    is the only place a linked task surfaces on the board. */}
                {linkedTaskId && (
                  <button
                    type="button"
                    onClick={() => onOpenTask(linkedTaskId)}
                    aria-label={`Open task for issue #${issue.id}`}
                    title="Started — open task"
                    className="absolute bottom-2 right-2 flex items-center gap-1 border border-line bg-surface px-1.5 py-0.5 text-[10px] text-subtle opacity-0 transition-opacity hover:border-primary hover:text-fg focus-visible:opacity-100 group-hover/wrap:opacity-100"
                  >
                    <ExternalLink size={10} strokeWidth={1.8} />
                    <span>open task</span>
                  </button>
                )}
              </div>
            )
          })
        )}
        {column.hiddenCount > 0 && (
          <div className="p-2 text-center text-[10px] text-subtle">
            +{column.hiddenCount} more — finish stories to thin this column
          </div>
        )}
      </div>
    </section>
  )
}

/** One project's column row. */
export function ProjectColumns({
  board,
  onNewIssue,
  onPeekIssue,
  onOpenTask,
  onDeleteIssue,
}: {
  board: ProjectBoard
  onNewIssue: (repo: string) => void
  onPeekIssue: (issue: Issue) => void
  onOpenTask: (taskId: string) => void
  onDeleteIssue: (repo: string, issue: Issue) => void
}) {
  return (
    <div className="flex h-full min-w-max gap-4">
      {board.columns.map((column) => (
        <ColumnView
          key={column.key}
          repo={board.repo}
          column={column}
          onNewIssue={
            column.key === "backlog" ? () => onNewIssue(board.repo) : undefined
          }
          onPeekIssue={onPeekIssue}
          onOpenTask={onOpenTask}
          onDeleteIssue={(issue) => onDeleteIssue(board.repo, issue)}
        />
      ))}
    </div>
  )
}
