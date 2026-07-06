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
      {}
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
